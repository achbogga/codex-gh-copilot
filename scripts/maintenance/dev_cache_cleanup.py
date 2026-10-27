#!/usr/bin/python3
"""Daily cleanup of explicitly identified developer caches; no root required."""

import argparse
import datetime
import fcntl
import json
import logging
import logging.handlers
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import time

import preserve_oci

USER_HOME = Path('/home/aboggaram')
STATE = USER_HOME / '.local/state/dev-cache-cleanup'
CACHE_ROOTS = [Path('/mnt/av-data/cache'), USER_HOME / '.cache']
BAZEL_AGE_HOURS = 24
PACKAGE_AGE_DAYS = 7
LOG = logging.getLogger('cache-cleanup')
PRESSURE_FREE_BYTES = 120 * 1024**3
TARGET_FREE_BYTES = 160 * 1024**3


def unique_dirs(paths, device=None):
    seen = set()
    for path in paths:
        if path.is_dir():
            resolved = path.resolve()
            if resolved not in seen and (device is None or resolved.stat().st_dev == device):
                seen.add(resolved)
                yield resolved


def run(command, dry_run, timeout=3600):
    LOG.info('%s %s', 'Would run:' if dry_run else 'Running:', ' '.join(map(str, command)))
    if dry_run:
        return
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                            text=True, timeout=timeout, check=False)
    if result.stdout.strip():
        LOG.info('%s', result.stdout.strip())
    if result.returncode:
        raise RuntimeError(f'Command exited {result.returncode}: {command}')


def has_live_server(base):
    try:
        pid = (base / 'server/server.pid.txt').read_text().strip()
        # Conservatively keep a cache whenever the recorded PID still exists.
        return pid.isdigit() and Path('/proc', pid).exists()
    except FileNotFoundError:
        return False


def last_used(base):
    # Include the lock timestamp: a client may have started without a command log.
    stamps = [base.stat().st_mtime]
    for name in ('command.log', 'lock', 'server/server.pid.txt'):
        try:
            stamps.append((base / name).stat().st_mtime)
        except FileNotFoundError:
            pass
    return max(stamps)


def remove_tree(path):
    # Bazel generates read-only directories. Change directory permissions only;
    # files may be hardlinked to repositories or the shared repository cache.
    run(['/usr/bin/find', str(path), '-xdev', '-type', 'd', '-exec',
         '/usr/bin/chmod', 'u+rwx', '--', '{}', '+'], False)
    run(['/usr/bin/rm', '-rf', '--one-file-system', '--', str(path)], False)


def clean_output_base(base, dry_run, cutoff):
    if base.is_symlink() or not base.is_dir() or not re.fullmatch('[0-9a-f]{32}', base.name):
        return
    if base.stat().st_uid != os.getuid():
        LOG.warning('Keeping cache owned by another user: %s', base)
        return
    if has_live_server(base):
        LOG.info('Keeping live Bazel output base: %s', base)
        return
    if last_used(base) >= cutoff:
        LOG.info('Keeping recently used Bazel output base: %s', base)
        return
    try:
        # Bazel uses fcntl locks. flock alone does not coordinate with its clients.
        fd = os.open(base / 'lock', os.O_RDWR | os.O_NOFOLLOW)
    except FileNotFoundError:
        LOG.warning('Keeping unrecognized output base without a lock file: %s', base)
        return
    with os.fdopen(fd, 'r+') as lock:
        try:
            fcntl.lockf(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            LOG.info('Keeping locked Bazel output base: %s', base)
            return
        if has_live_server(base) or last_used(base) >= cutoff:
            LOG.info('Keeping Bazel output base that became active: %s', base)
            return
        # Keep the directory and lock inode so waiting clients stay coordinated.
        children = [p for p in base.iterdir() if p.name != 'lock']
        if not children:
            return
        LOG.info('%s inactive Bazel output base: %s', 'Would empty' if dry_run else 'Emptying', base)
        if dry_run:
            return
        for child in children:
            if child.is_symlink() or not child.is_dir():
                child.unlink(missing_ok=True)
            else:
                if child.stat().st_dev != base.stat().st_dev:
                    raise RuntimeError(f'Refusing to cross a filesystem boundary: {child}')
                remove_tree(child)
        LOG.info('Emptied inactive Bazel output base: %s', base)


def expire_files(root, seconds, dry_run):
    if dry_run:
        LOG.info('Would expire regular files unused/unmodified for %.1f days in %s', seconds / 86400, root)
        return
    cutoff = time.time() - seconds
    count = size = 0
    device = root.stat().st_dev
    for directory, dirs, files in os.walk(root, followlinks=False):
        parent = Path(directory)
        dirs[:] = [name for name in dirs if not (parent / name).is_symlink()
                   and (parent / name).stat().st_dev == device]
        for name in files:
            path = parent / name
            try:
                info = path.lstat()
                if (stat.S_ISREG(info.st_mode) and info.st_uid == os.getuid()
                        and max(info.st_mtime, info.st_atime, info.st_ctime) < cutoff
                        and 'lock' not in name.lower()):
                    path.unlink()
                    count += 1
                    size += info.st_size
            except FileNotFoundError:
                continue
    LOG.info('Expired %d files (%.2f GiB logical size) in %s', count, size / 1024**3, root)


def docker_cleanup(dry_run):
    # Pin the local daemon, even when an interactive shell selects a remote one.
    docker = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
    run(docker + ['buildx', '--builder', 'default', 'prune', '--all', '--force',
                  '--filter', 'until=24h'], dry_run)
    # Dangling image layers are cache; preserve tagged images and all containers.
    run(docker + ['image', 'prune', '--force', '--filter', 'until=24h'], dry_run)
    docker_untagged_images(docker, dry_run)


def docker_read(docker, arguments):
    result = subprocess.run(docker + arguments, capture_output=True, text=True,
                            timeout=60, check=True)
    return result.stdout


def docker_untagged_images(docker, dry_run, now=None):
    """Drop unused digest-only imports which Docker's dangling prune retains.

    Remove digest references without --force, so a concurrent tag or container
    stays protected by Docker. Never prune containers, volumes or tagged images.
    """
    cutoff = (time.time() if now is None else now) - 24 * 3600
    images = sorted(set(docker_read(docker, ['image', 'ls', '--all', '--quiet',
                                           '--no-trunc']).split()))
    container_ids = docker_read(docker, ['container', 'ls', '--all', '--quiet']).split()
    used = {item['Image'] for item in json.loads(
        docker_read(docker, ['container', 'inspect', *container_ids]))} if container_ids else set()
    for image_id in images:
        try:
            image = json.loads(docker_read(docker, ['image', 'inspect', image_id]))[0]
        except subprocess.CalledProcessError:
            LOG.info('Keeping image that changed during inspection: %s', image_id)
            continue
        if image.get('RepoTags') or image['Id'] in used:
            continue
        created = datetime.datetime.fromisoformat(image['Created'].replace('Z', '+00:00'))
        if created.timestamp() >= cutoff:
            continue
        # Plain dangling images were handled above by Docker's native prune.
        # Never fall back to removal by ID: a concurrent new tag must survive.
        for reference in image.get('RepoDigests') or []:
            command = docker + ['image', 'rm', reference]
            LOG.info('%s unused untagged image: %s', 'Would remove' if dry_run else 'Removing', reference)
            if dry_run:
                continue
            result = subprocess.run(command, capture_output=True, text=True, timeout=300)
            if result.returncode:
                LOG.warning('Kept image reference after Docker refused removal: %s', reference)
            else:
                LOG.info('Removed image reference and %d unused layers', result.stdout.count('Deleted:'))


def preserve_snapshots(dry_run):
    # Daily and pressure cache sweeps can overlap; snapshot publication cannot.
    with (STATE / 'snapshot-preservation.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            LOG.info('Snapshot preservation is already running')
            return
        docker = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
        containers = docker_read(docker, ['container', 'ls', '--all', '--quiet']).split()
        inspected = json.loads(docker_read(docker, ['container', 'inspect', *containers])) if containers else []
        mounts = [Path(mount['Source']) for item in inspected for mount in item.get('Mounts', [])
                  if mount.get('Source')]
        preserve_oci.cleanup(dry_run, TARGET_FREE_BYTES, mounts)


def record_status(pressure, status, before, errors=()):
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    free = shutil.disk_usage(USER_HOME).free
    label = 'last-pressure-run' if pressure else 'last-run'
    preserve_oci.save(STATE / (label + '.json'), {
        'checked_at': now, 'status': status, 'root_free_bytes': free,
        'root_free_before_bytes': before, 'root_free_change_bytes': free - before,
        'trigger_free_bytes': PRESSURE_FREE_BYTES, 'target_free_bytes': TARGET_FREE_BYTES,
        'failed_tasks': list(errors),
    })
    (STATE / (label + '.txt')).write_text(f'{now} {status}\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--pressure', action='store_true',
                        help='Run below 120 GiB root free space, or finish interrupted snapshot preservation')
    args = parser.parse_args()
    if os.getuid() != USER_HOME.stat().st_uid:
        parser.error('Run as aboggaram, not root')
    before = shutil.disk_usage(USER_HOME).free
    if args.pressure and before >= PRESSURE_FREE_BYTES and not preserve_oci.pending():
        STATE.mkdir(parents=True, exist_ok=True)
        if not args.dry_run:
            record_status(True, 'healthy', before)
        else:
            print(f'Root pressure check healthy: {before / 1024**3:.1f} GiB available')
        return 0
    STATE.mkdir(parents=True, exist_ok=True)
    # Pressure recovery must not wait up to six hours behind a daily data-volume
    # sweep. Docker enforces image references and Bazel has its own fcntl locks.
    lock_name = 'dev-cache-cleanup-pressure.lock' if args.pressure else 'dev-cache-cleanup.lock'
    with (USER_HOME / '.cache' / lock_name).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('Another cache cleanup is already running; skipping.')
            return 0
        handlers = [logging.StreamHandler(sys.stdout)]
        try:
            handlers.insert(0, logging.handlers.RotatingFileHandler(
                STATE / 'daily.log', maxBytes=5 * 1024**2, backupCount=3))
        except OSError:
            # Full-disk recovery must still run when its log cannot be opened.
            pass
        logging.basicConfig(level=logging.INFO, format='%(asctime)sZ %(levelname)s %(message)s',
                            handlers=handlers)
        logging.Formatter.converter = time.gmtime
        LOG.info('Starting cleanup; pressure=%s; dry_run=%s', args.pressure, args.dry_run)
        errors = []

        def task(label, function, *arguments):
            try:
                function(*arguments)
            except Exception as error:
                LOG.exception('Cleanup failed for %s: %s', label, error)
                errors.append(label)

        # Fast native cache pruning runs before potentially large Bazel trees.
        task('Docker', docker_cleanup, args.dry_run)
        roots = list(unique_dirs(CACHE_ROOTS))
        # Filter each resolved leaf: a root-resident ~/.cache can contain links
        # to another filesystem. Filtering only its parent did not exclude them.
        device = USER_HOME.stat().st_dev if args.pressure else None
        for root in unique_dirs([r / name for r in roots for name in
                                 ('pip', 'pip-tools', 'gh', 'black', 'YAPF',
                                  'fontconfig', 'matplotlib', 'virtualenv/wheel')]
                                + [USER_HOME / '.npm/_logs'], device=device):
            task(str(root), expire_files, root, PACKAGE_AGE_DAYS * 86400, args.dry_run)
        for root in unique_dirs([r / name for r in roots for name in ('uv', 'sml5669-uv-cache')], device=device):
            task(str(root), run, [str(USER_HOME / '.local/bin/uv'), '--no-config', '--offline',
                                 'cache', 'prune', '--cache-dir', str(root)], args.dry_run)
        all_output_roots = list(unique_dirs([r / 'bazel/_bazel_aboggaram' for r in roots]))
        output_roots = list(unique_dirs(all_output_roots, device=device))
        cutoff = time.time() - BAZEL_AGE_HOURS * 3600
        for root in output_roots:
            for base in sorted(root.iterdir()):
                task(str(base), clean_output_base, base, args.dry_run, cutoff)
        # The shared repository cache can be read by live servers; only expire
        # those files when all output bases are idle. The next daily job retries.
        live = any(has_live_server(base) for r in all_output_roots for base in r.iterdir()
                   if base.is_dir() and not base.is_symlink()
                   and re.fullmatch('[0-9a-f]{32}', base.name))
        if live:
            LOG.info('Deferring shared Bazel disk/repository cache cleanup while servers are live')
        else:
            for root in unique_dirs([r / 'bazel-cache' for r in roots]
                                    + [r / 'cache' for r in all_output_roots], device=device):
                task(str(root), expire_files, root, BAZEL_AGE_HOURS * 3600, args.dry_run)
        if shutil.disk_usage(USER_HOME).free < TARGET_FREE_BYTES or preserve_oci.pending():
            task('OCI snapshot preservation', preserve_snapshots, args.dry_run)
        for root in (Path('/mnt/av-data'), USER_HOME):
            usage = shutil.disk_usage(root)
            LOG.info('Disk %s: %.1f GiB free / %.1f GiB total', root,
                     usage.free / 1024**3, usage.total / 1024**3)
        if not args.dry_run and shutil.disk_usage(USER_HOME).free < PRESSURE_FREE_BYTES:
            LOG.error('Root space remains below 120 GiB after cleanup and snapshot preservation; inspect current writers and retained artifacts')
            errors.append('root-space-remains-low')
        status = 'failed' if errors else 'success'
        LOG.info('Cleanup complete; status=%s; failed tasks=%s', status, errors)
        if not args.dry_run:
            record_status(args.pressure, status, before, errors)
        if errors:
            # Cron discards stdout; failures must also reach its stderr log.
            print(f'Developer cache cleanup failed: {", ".join(errors)}. '
                  f'Root free: {shutil.disk_usage(USER_HOME).free / 1024**3:.1f} GiB; see {STATE / "daily.log"}',
                  file=sys.stderr)
        return 1 if errors else 0


if __name__ == '__main__':
    sys.exit(main())
