"""Preserve inactive temporary OCI snapshots off the root filesystem.

This is relocation, not archive expiration. Receipts precede the atomic path
switch, and interrupted copies or duplicate removal are resumed on the next run.
"""

import ctypes
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import time

LOG = logging.getLogger('cache-cleanup')
TEMP_ROOT = Path('/tmp')
ARCHIVE_ROOT = Path('/mnt/av-data/cache/preserved-session-artifacts/cron-oci')
NAME = re.compile(r'sml[0-9]+-(?:train-)?oci-[A-Za-z0-9_-]+')
MIN_AGE = 7 * 86400
MIN_BYTES = 1024**3
DATA_RESERVE = 200 * 1024**3


def tree_state(root):
    """Bound the scan and reject symlinks, mounts, special files and other owners."""
    result = {}
    device = root.lstat().st_dev
    pending = [root]
    while pending:
        path = pending.pop()
        info = path.lstat()
        if (info.st_dev != device or info.st_uid != os.getuid()
                or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode))):
            raise ValueError('Snapshot contains a link, mount, special file or different owner')
        result[str(path.relative_to(root))] = (info.st_dev, info.st_ino, info.st_mode,
                                               info.st_size, info.st_mtime_ns, info.st_ctime_ns)
        if len(result) > 10000:
            raise ValueError('Snapshot exceeds the bounded inventory size')
        if stat.S_ISDIR(info.st_mode):
            pending.extend(path.iterdir())
    return result


def candidate(source, now):
    if source.is_symlink() or not source.is_dir() or not NAME.fullmatch(source.name):
        return None
    snapshot = tree_state(source)
    if any(max(info[4:]) >= (now - MIN_AGE) * 1e9 for info in snapshot.values()):
        return None
    layout = source / 'layout' if (source / 'layout').is_dir() else source
    if layout != source and {p.name for p in source.iterdir()} != {'layout'}:
        return None
    if {p.name for p in layout.iterdir()} != {'oci-layout', 'index.json', 'blobs'}:
        return None  # Includes explicit keep markers and non-image artifacts.
    if any((layout / name).stat().st_size > 1024**2 for name in ('oci-layout', 'index.json')):
        return None
    if json.loads((layout / 'oci-layout').read_text()).get('imageLayoutVersion') != '1.0.0':
        return None
    index = json.loads((layout / 'index.json').read_text())
    manifests = index.get('manifests')
    if index.get('schemaVersion') != 2 or not isinstance(manifests, list) or not manifests:
        return None
    for descriptor in manifests:
        digest = descriptor.get('digest', '')
        if not re.fullmatch('sha256:[0-9a-f]{64}', digest):
            return None
        blob = layout / 'blobs/sha256' / digest.split(':')[1]
        if not blob.is_file() or blob.stat().st_size != descriptor.get('size'):
            return None
    size = sum(info[3] for info in snapshot.values() if stat.S_ISREG(info[2]))
    return (snapshot, size) if size >= MIN_BYTES else None


def referenced(source, mounts):
    """Keep container-bound paths and snapshots referenced by live processes."""
    if any(source == mount or source.is_relative_to(mount) or mount.is_relative_to(source)
           for mount in mounts):
        return True
    prefix = str(source)
    for proc in Path('/proc').iterdir():
        if not proc.name.isdigit():
            continue
        try:
            if proc.stat().st_uid != os.getuid():
                continue
            if prefix.encode() in (proc / 'cmdline').read_bytes():
                return True
            for link in [proc / 'cwd', proc / 'root', *(proc / 'fd').iterdir()]:
                try:
                    target = os.readlink(link)
                except (FileNotFoundError, PermissionError):
                    continue
                if target == prefix or target.startswith(prefix + '/'):
                    return True
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
    return False


def save(path, value):
    temporary = path.with_suffix('.tmp')
    with temporary.open('w') as stream:
        json.dump(value, stream, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    temporary.replace(path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def exchange(first, second):
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(-100, os.fsencode(first), -100, os.fsencode(second), 2):
        error = ctypes.get_errno()
        raise OSError(error, os.strerror(error))
    fd = os.open(first.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def verify(source, destination, partial=False):
    # After an interrupted deletion, destination legitimately has extra files.
    arguments = ['-rnci'] if partial else ['-aHnci', '--delete']
    result = subprocess.run(['/usr/bin/rsync', *arguments, '--', str(source) + '/', str(destination) + '/'],
                            capture_output=True, text=True, timeout=1800, check=True)
    if result.stdout:
        raise RuntimeError('Snapshot copy differs; originals retained')


def finish(receipt, record, mounts):
    source, destination, retired = (Path(record[key]) for key in ('source', 'destination', 'retired'))
    if not source.is_symlink() or source.resolve() != destination:
        raise RuntimeError('Original snapshot path changed; refusing duplicate removal')
    tree_state(destination)
    if retired.exists():
        if retired.is_symlink() or (retired.stat().st_dev, retired.stat().st_ino) != tuple(record['identity']):
            raise RuntimeError('Retired snapshot identity changed')
        tree_state(retired)
        if referenced(retired, mounts) or referenced(source, mounts):
            raise RuntimeError('Retired snapshot remains in use; both copies retained')
        verify(retired, destination, partial=True)
        # Only duplicate directories change permissions; hardlinked files and
        # the retained archive keep their original modes and contents.
        for base, dirs, _ in os.walk(retired):
            for path in [Path(base), *(Path(base) / name for name in dirs)]:
                path.chmod(path.stat().st_mode | stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
        shutil.rmtree(retired)
    record['stage'] = 'complete'
    save(receipt, record)
    LOG.info('Preserved snapshot at %s; original path %s remains available', destination, source)


def preserve(source, snapshot, size, mounts, archive=ARCHIVE_ROOT):
    identity = snapshot['.']
    key = source.name + '-' + hashlib.sha256(repr(identity).encode()).hexdigest()[:16]
    destination = archive / key
    retired = source.with_name('.' + key + '.preserving')
    receipt = archive / 'receipts' / (key + '.json')
    record = {'source': str(source), 'destination': str(destination), 'retired': str(retired),
              'identity': list(identity[:2]), 'bytes': size, 'stage': 'copying'}
    if receipt.exists():
        previous = json.loads(receipt.read_text())
        if any(previous.get(k) != record[k] for k in ('source', 'destination', 'retired', 'identity')):
            raise RuntimeError('Existing preservation intent belongs to another snapshot')
    elif destination.exists() or retired.exists() or retired.is_symlink():
        raise RuntimeError('Unowned preservation path already exists')
    if referenced(source, mounts):
        raise RuntimeError('Snapshot became active; source retained')
    if shutil.disk_usage(archive).free < size + DATA_RESERVE:
        raise RuntimeError('Data volume cannot preserve this snapshot and its 200 GiB reserve')
    save(receipt, record)  # Recoverable intent precedes creation of retained data.
    if destination.exists():
        tree_state(destination)
    destination.mkdir(exist_ok=True)
    LOG.info('Preserving %.2f GiB snapshot %s', size / 1024**3, source)
    subprocess.run(['/usr/bin/rsync', '-aH', '--fsync', '--', str(source) + '/', str(destination) + '/'],
                   check=True, timeout=1800)
    verify(source, destination)
    if tree_state(source) != snapshot or referenced(source, mounts):
        raise RuntimeError('Snapshot changed or became active during copy; originals retained')
    record['stage'] = 'verified'
    save(receipt, record)
    if not retired.is_symlink():
        retired.symlink_to(destination, target_is_directory=True)
    if retired.resolve() != destination:
        raise RuntimeError('Prepared path changed')
    exchange(source, retired)
    record['stage'] = 'redirected'
    save(receipt, record)
    finish(receipt, record, mounts)


def pending(archive=ARCHIVE_ROOT):
    result = []
    for path in (archive / 'receipts').glob('*.json'):
        try:
            if json.loads(path.read_text()).get('stage') == 'complete':
                continue
        except (OSError, ValueError):
            pass  # Let the real cleanup report the damaged receipt, even above the trigger.
        result.append(path)
    return result


def cleanup(dry_run, target_free, mounts, temporary=TEMP_ROOT, archive=ARCHIVE_ROOT):
    if not dry_run:
        archive.mkdir(parents=True, exist_ok=True, mode=0o700)
        (archive / 'receipts').mkdir(exist_ok=True, mode=0o700)
    elif not archive.parent.is_dir():
        raise RuntimeError('Preservation volume is unavailable')
    if temporary.stat().st_dev == archive.parent.stat().st_dev:
        raise RuntimeError('Preservation destination must be on a different filesystem')
    for receipt in pending(archive):
        record = json.loads(receipt.read_text())
        source, destination, retired = (Path(record[key]) for key in ('source', 'destination', 'retired'))
        if (source.parent != temporary or not NAME.fullmatch(source.name) or destination.parent != archive
                or retired.parent != temporary or retired.name != '.' + destination.name + '.preserving'
                or receipt.stem != destination.name):
            raise RuntimeError('Invalid preservation receipt; no paths changed')
        if source.is_symlink():
            LOG.info('%s interrupted snapshot preservation: %s', 'Would finish' if dry_run else 'Finishing', source)
            if not dry_run:
                finish(receipt, record, mounts)
        elif source.is_dir():
            found = candidate(source, time.time())
            if not found or referenced(source, mounts):
                LOG.warning('Interrupted snapshot is now recent or active; retaining both paths: %s', source)
                continue
            snapshot, size = found
            key = source.name + '-' + hashlib.sha256(repr(snapshot['.']).encode()).hexdigest()[:16]
            if destination.name != key:
                raise RuntimeError('Interrupted snapshot root changed; source and partial copy retained')
            LOG.info('%s interrupted snapshot copy: %s', 'Would resume' if dry_run else 'Resuming', source)
            if not dry_run:
                preserve(source, snapshot, size, mounts, archive)
        else:
            raise RuntimeError('Interrupted snapshot source is unavailable; retained data left untouched')
    for source in sorted(temporary.iterdir()):
        if not dry_run and shutil.disk_usage(temporary).free >= target_free:
            break
        try:
            found = candidate(source, time.time())
        except (OSError, ValueError, KeyError, TypeError) as error:
            LOG.warning('Keeping unrecognized snapshot %s: %s', source, error)
            continue
        if not found:
            continue
        if referenced(source, mounts):
            LOG.info('Keeping active or container-bound snapshot: %s', source)
            continue
        snapshot, size = found
        if dry_run:
            LOG.info('Would preserve %.2f GiB from %s on the data volume', size / 1024**3, source)
        else:
            preserve(source, snapshot, size, mounts, archive)
