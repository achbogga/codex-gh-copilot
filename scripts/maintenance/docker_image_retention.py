"""Reclaim unused tagged images only after recording a verified restore source."""

import fcntl
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import time

import preserve_oci

LOG = logging.getLogger('cache-cleanup')
DOCKER = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
ARCHIVES = Path('/mnt/av-data/cache/preserved-session-artifacts/docker-images')
MIN_UNUSED_SECONDS = 7 * 86400
MAX_OBSERVATION_GAP = 2 * 86400
DATA_RESERVE = 200 * 1024**3


def read(arguments, timeout=60):
    result = subprocess.run(DOCKER + arguments, capture_output=True, text=True,
                            timeout=timeout, check=True)
    return result.stdout


def inventory():
    ids = sorted(set(read(['image', 'ls', '--all', '--quiet', '--no-trunc']).split()))
    images = json.loads(read(['image', 'inspect', *ids])) if ids else []
    containers = read(['container', 'ls', '--all', '--quiet']).split()
    used = {item['Image'] for item in json.loads(read(['container', 'inspect', *containers]))} if containers else set()
    return images, used


def storage_on_root():
    root = Path(read(['info', '--format', '{{.DockerRootDir}}']).strip())
    return root.stat().st_dev == Path('/').stat().st_dev


def references(image):
    return sorted(image.get('RepoTags') or []) + sorted(image.get('RepoDigests') or [])


def observations(images, used, previous, now):
    """Image Created is often a fixed reproducible-build timestamp, not cache age."""
    result = {}
    for image in images:
        identity = image['Id']
        # Docker requires force to remove an ID with multiple tags. Keep those
        # aliases instead of exporting an image that cannot be safely removed.
        if identity in used or len(image.get('RepoTags') or []) != 1:
            continue
        old = previous.get(identity, {})
        continuous = (old.get('references') == references(image)
                      and 0 <= now - old.get('last_observed', 0) <= MAX_OBSERVATION_GAP)
        result[identity] = {
            'unused_since': old['unused_since'] if continuous else now,
            'last_observed': now,
            'references': references(image),
        }
    return result


def verify_archive(path, identity):
    """Check the config identity and every uncompressed layer against its diff ID."""
    with tarfile.open(path, 'r:') as archive:
        manifest = json.load(archive.extractfile('manifest.json'))
        if len(manifest) != 1:
            raise ValueError('Expected one image in Docker archive')
        entry = manifest[0]
        config_bytes = archive.extractfile(entry['Config']).read()
        if 'sha256:' + hashlib.sha256(config_bytes).hexdigest() != identity:
            raise ValueError('Archive config does not match the selected image')
        config = json.loads(config_bytes)
        expected = config['rootfs']['diff_ids']
        if len(entry['Layers']) != len(expected):
            raise ValueError('Archive layer count differs from image config')
        for name, digest in zip(entry['Layers'], expected):
            actual = 'sha256:' + hashlib.file_digest(archive.extractfile(name), 'sha256').hexdigest()
            if actual != digest:
                raise ValueError(f'Archive layer does not match its diff ID: {name}')


def recovery_source(image, archive_root):
    identity = image['Id']
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', identity):
        raise ValueError('Invalid Docker image identity')
    # Verify an immutable registry reference against the local config, without
    # downloading layers or trusting a mutable tag to still name the same image.
    for reference in image.get('RepoDigests') or []:
        try:
            manifest = json.loads(read(['manifest', 'inspect', reference], timeout=45))
            if manifest.get('config', {}).get('digest') == identity:
                return {'kind': 'registry', 'reference': reference}
            for descriptor in manifest.get('manifests', []):
                platform = descriptor.get('platform', {})
                if (platform.get('os') != image.get('Os')
                        or platform.get('architecture') != image.get('Architecture')):
                    continue
                digest = descriptor.get('digest', '')
                if not re.fullmatch(r'sha256:[0-9a-f]{64}', digest):
                    continue
                child = reference.split('@')[0] + '@' + digest
                selected = json.loads(read(['manifest', 'inspect', child], timeout=45))
                if selected.get('config', {}).get('digest') == identity:
                    return {'kind': 'registry', 'reference': child}
        except (subprocess.SubprocessError, ValueError):
            LOG.warning('Could not verify registry restore source: %s', reference)
    # A temporary registry outage must not trigger large unnecessary exports.
    if image.get('RepoDigests'):
        raise RuntimeError('No registry reference verified; keeping image')
    archive_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    if archive_root.stat().st_dev == Path('/').stat().st_dev:
        raise RuntimeError('Image archives must be on a separate filesystem')
    destination = archive_root / (identity.split(':')[1] + '.tar')
    if not destination.exists():
        if shutil.disk_usage(archive_root).free - image['Size'] < DATA_RESERVE:
            raise RuntimeError('Image export would consume the data disk reserve')
        # Docker stages layer tar files in its own data root before streaming the
        # archive. Leave room for that transient copy even with an off-root output.
        if shutil.disk_usage('/').free < 2 * image['Size'] + 20 * 1024**3:
            raise RuntimeError('Insufficient root headroom for Docker export staging; keeping image')
        temporary = destination.with_suffix('.partial')
        LOG.info('Saving local-only image %s to %s', identity, temporary)
        subprocess.run(DOCKER + ['image', 'save', '--output', str(temporary), identity],
                       check=True, timeout=1200, stdout=subprocess.DEVNULL)
        verify_archive(temporary, identity)
        with temporary.open('rb') as stream:
            os.fsync(stream.fileno())
        temporary.replace(destination)
    else:
        verify_archive(destination, identity)
    return {'kind': 'archive', 'path': str(destination),
            'bytes': destination.stat().st_size, 'verified_image_id': identity}


def reclaim(image, archive_root):
    """Persist recovery evidence before removal; Docker retains images in use."""
    identity = image['Id']
    recovery = recovery_source(image, archive_root)
    receipt = archive_root / (identity.split(':')[1] + '.json')
    record = {'image_id': identity, 'tags': image.get('RepoTags') or [],
              'digests': image.get('RepoDigests') or [], 'recovery': recovery,
              'verified_at': time.time(), 'status': 'verified'}
    preserve_oci.save(receipt, record)
    current, used = inventory()
    current = next((item for item in current if item['Id'] == identity), None)
    if current is None:
        record['status'] = 'already-absent'
    elif identity in used or references(current) != references(image):
        record['status'] = 'kept-changed-or-in-use'
    else:
        # No --force: a newly created container or additional tag blocks removal.
        result = subprocess.run(DOCKER + ['image', 'rm', identity], capture_output=True,
                                text=True, timeout=300)
        record['status'] = 'removed' if result.returncode == 0 else 'kept-daemon-refused'
        if result.returncode:
            LOG.warning('Docker retained %s: %s', identity, result.stderr.strip())
    preserve_oci.save(receipt, record)
    LOG.info('Image retention: %s %s; recovery=%s', identity, record['status'], recovery['kind'])
    return record


def sweep(state, dry_run, target_free_bytes, reclaim_now=False, archive_root=ARCHIVES):
    with (state / 'image-retention.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            LOG.info('Image retention is already running')
            return
        images, used = inventory()
        ledger = state / 'unused-images.json'
        previous = json.loads(ledger.read_text()) if ledger.exists() else {}
        now = time.time()
        observed = observations(images, used, previous, now)
        if not dry_run:
            preserve_oci.save(ledger, observed)
        if not storage_on_root():
            LOG.info('Docker storage is off the root filesystem; no root space can be reclaimed there')
            return
        eligible = [image for image in images if image['Id'] in observed
                    and (reclaim_now or now - observed[image['Id']]['unused_since'] >= MIN_UNUSED_SECONDS)]
        # Registry-backed images are cheap to recover. Export local-only images
        # only if pressure remains after those caches have been reclaimed.
        eligible.sort(key=lambda image: (not bool(image.get('RepoDigests')), -image['Size']))
        failures = []
        for image in eligible:
            if shutil.disk_usage('/').free >= target_free_bytes:
                break
            LOG.info('%s unused tagged image: %s %s', 'Would preserve and reclaim' if dry_run else 'Preserving and reclaiming',
                     image['Id'], image.get('RepoTags'))
            if dry_run:
                continue
            archive_root.mkdir(mode=0o700, parents=True, exist_ok=True)
            try:
                reclaim(image, archive_root)
            except (OSError, ValueError, RuntimeError, subprocess.SubprocessError, tarfile.TarError):
                LOG.exception('Keeping image after preservation failed: %s', image['Id'])
                failures.append(image['Id'])
        if failures:
            raise RuntimeError(f'Could not preserve {len(failures)} images; their local copies were retained')


def restore(receipt):
    """Restore preserved content and original tags, refusing conflicting tags."""
    record = json.loads(Path(receipt).read_text())
    identity = record['image_id']
    images, _ = inventory()
    tags = {tag: image['Id'] for image in images for tag in image.get('RepoTags') or []}
    if any(tag in tags and tags[tag] != identity for tag in record['tags']):
        raise RuntimeError('An original tag now names another image; restore refused')
    source = record['recovery']
    if source['kind'] == 'registry':
        subprocess.run(DOCKER + ['image', 'pull', source['reference']], check=True)
    elif source['kind'] == 'archive':
        verify_archive(Path(source['path']), identity)
        subprocess.run(DOCKER + ['image', 'load', '--input', source['path']], check=True)
    else:
        raise ValueError('Unknown recovery source')
    if json.loads(read(['image', 'inspect', identity]))[0]['Id'] != identity:
        raise RuntimeError('Restored image identity differs')
    for tag in record['tags']:
        images, _ = inventory()
        if any(tag in (image.get('RepoTags') or []) and image['Id'] != identity for image in images):
            raise RuntimeError(f'Tag changed during restoration: {tag}')
        subprocess.run(DOCKER + ['image', 'tag', identity, tag], check=True)


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--restore', required=True, type=Path, help='Restore the image described by a saved JSON receipt')
    restore(parser.parse_args().restore)
