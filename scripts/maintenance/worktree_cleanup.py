"""Retire inactive Git checkouts after PR, activity and recovery checks.

This is host maintenance: invoke Git directly, without sourcing a checkout's
environment (which can launch builds). Never force removal or delete branches.
"""

import argparse
import datetime
import fcntl
import glob
import hashlib
import json
import logging
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import subprocess
import tarfile
import time
import uuid

import preserve_oci

LOG = logging.getLogger('worktree-cleanup')
DAY = 86400
FIELDS = 'number,headRefName,headRefOid,state,closedAt,url'


class Keep(Exception):
    """A checkout is not safe to retire."""


def command(args, cwd=None, timeout=180):
    return subprocess.check_output(args, cwd=cwd, stderr=subprocess.PIPE, timeout=timeout)


def git(repo, *args):
    return command(['/usr/bin/git', '--no-optional-locks', '-C', str(repo), *args])


def worktree_roots(config):
    names = config['worktree_roots'] if 'worktree_roots' in config else [config['worktree_root']]
    return {Path(name).resolve(strict=True) for name in names}


def worktrees(repo):
    records = []
    for block in git(repo, 'worktree', 'list', '--porcelain', '-z').split(b'\0\0'):
        record = {}
        for field in filter(None, block.split(b'\0')):
            key, _, value = os.fsdecode(field).partition(' ')
            record[key] = value
        if record:
            records.append(record)
    return records


def pull_requests(repository, branch=None):
    limit = 100 if branch else 10000
    args = ['gh', 'pr', 'list', '--repo', repository, '--state', 'all' if branch else 'open',
            '--limit', str(limit), '--json', FIELDS]
    if branch:
        args += ['--head', branch]
    result = json.loads(command(args, timeout=300))
    if len(result) >= limit:
        raise RuntimeError('PR results may be truncated; no checkouts will be removed')
    return result


def pr_reason(record, open_prs, branch_prs, now):
    branch = record.get('branch', '').removeprefix('refs/heads/')
    if any(p['headRefOid'] == record['HEAD'] or (branch and p['headRefName'] == branch)
           for p in open_prs):
        raise Keep('open PR')
    if branch:
        matches = [p for p in branch_prs if p['headRefName'] == branch]
        if not matches or any(p['state'] == 'OPEN' or not p['closedAt'] for p in matches):
            raise Keep('branch has no confirmed closed PR')
        if any(now - datetime.datetime.fromisoformat(p['closedAt'].replace('Z', '+00:00')).timestamp()
               < 7 * DAY for p in matches):
            raise Keep('PR closed less than seven days ago')
        return 'closed PR'
    return 'inactive detached checkout'


def thread_paths(databases):
    paths = set()
    for pattern in databases:
        names = glob.glob(pattern)
        if not names:
            raise FileNotFoundError('Configured thread database is unavailable')
        for name in names:
            path = Path(name).resolve(strict=True)
            with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True, timeout=10) as db:
                paths.update(Path(row[0]).resolve() for row in db.execute(
                    'SELECT DISTINCT cwd FROM threads WHERE archived = 0'))
    return paths


def mounts():
    docker = ['/usr/bin/docker', '--host', 'unix:///var/run/docker.sock']
    ids = command(docker + ['container', 'ls', '--all', '--quiet']).decode().split()
    records = json.loads(command(docker + ['container', 'inspect', *ids])) if ids else []
    return [Path(m['Source']).resolve() for item in records for m in item.get('Mounts', [])
            if m.get('Source')]


def protect(path, config, container_mounts):
    protected = {Path(p).resolve() for p in config['protected_paths']}
    protected |= thread_paths(config['thread_databases'])
    # A thread opened at the worktree parent doesn't claim every sibling checkout.
    if any(p == path or p.is_relative_to(path) for p in protected):
        raise Keep('protected path or unarchived thread')
    if (path / '.keep-worktree').exists() or (path / '.keep-worktree').is_symlink():
        raise Keep('keep marker')
    if preserve_oci.referenced(path, container_mounts):
        raise Keep('live process or container reference')


def inventory(root):
    """Fingerprint every entry without following symlinks or crossing mounts."""
    entries = {}
    device = root.lstat().st_dev
    pending = [root]
    size = 0
    while pending:
        path = pending.pop()
        info = path.lstat()
        if (info.st_uid != os.getuid() or info.st_dev != device or path.is_mount()
                or not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode)
                        or stat.S_ISLNK(info.st_mode))):
            raise Keep('mount, special file or different owner')
        name = str(path.relative_to(root))
        entries[name] = (info.st_dev, info.st_ino, info.st_mode, info.st_size,
                         info.st_mtime_ns, info.st_ctime_ns)
        size += info.st_blocks * 512
        if len(entries) > 300000:
            raise Keep('inventory exceeds safety bound')
        if stat.S_ISDIR(info.st_mode):
            pending.extend(path.iterdir())
    return entries, size


def checkout_state(repo, record, config, container_mounts, now):
    path = Path(record['worktree'])
    if path.is_symlink() or not path.is_dir() or path.resolve() != path:
        raise Keep('missing or symlinked checkout')
    if 'locked' in record or 'prunable' in record or 'bare' in record:
        raise Keep('locked or unrecognized registration')
    protect(path, config, container_mounts)
    gitdir = Path(os.fsdecode(git(path, 'rev-parse', '--absolute-git-dir')).strip())
    for name in ('index.lock', 'HEAD.lock', 'rebase-merge', 'rebase-apply', 'MERGE_HEAD',
                 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_START', 'sequencer'):
        if (gitdir / name).exists():
            raise Keep('Git operation in progress')
    stamps = [max(p.stat().st_mtime, p.stat().st_ctime)
              for p in (path, path / '.git', gitdir / 'HEAD', gitdir / 'index', gitdir / 'logs/HEAD')
              if p.exists()]
    if now - max(stamps) < 14 * DAY:
        raise Keep('checkout used within fourteen days')
    if git(path, 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'):
        raise Keep('uncommitted or untracked files')
    # Status can hide modifications under assume-unchanged/skip-worktree flags.
    flags = git(path, 'ls-files', '-v', '-z').split(b'\0')
    special = [f for f in flags if f and f[:1] != b'H']
    if special:
        sparse = subprocess.run(['/usr/bin/git', '-C', str(path), 'config', '--bool',
                                 'core.sparseCheckout'], capture_output=True, check=False)
        if (sparse.returncode != 0 or sparse.stdout.strip() != b'true'
                or any(f[:1] != b'S' or os.path.lexists(path / os.fsdecode(f[2:])) for f in special)):
            raise Keep('index flags or hidden files need manual inspection')
    if b'160000 ' in git(path, 'ls-files', '--stage', '-z'):
        raise Keep('submodules need manual inspection')
    local_commit = not git(repo, 'for-each-ref', '--contains=' + record['HEAD'],
                           '--format=%(refname)', 'refs/remotes').strip()
    if local_commit and not config.get('archive_local_commits', False):
        raise Keep('commits not reachable from a saved remote reference')
    tree, size = inventory(path)
    metadata, _ = inventory(gitdir)
    ignored = [os.fsdecode(p) for p in git(path, 'ls-files', '--others', '--ignored',
                                         '--exclude-standard', '-z').split(b'\0') if p]
    generated = set(config.get('activity_ignored_files', [])) & set(ignored)
    generated = {name for name in generated if name in tree and stat.S_ISREG(tree[name][2])}
    if any(now - max(item[4:]) / 1e9 < 14 * DAY
           for name, item in tree.items() if name not in generated):
        raise Keep('recent file changes')
    return {'tree': tree, 'metadata': metadata, 'size': size, 'gitdir': gitdir,
            'ignored': ignored, 'local_commit': local_commit}


def digest(stream):
    value = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        value.update(chunk)
    return value.hexdigest()


def archive_local(path, state, destination):
    """Preserve ignored files and per-worktree Git metadata, verifying all bytes."""
    files = {'ignored/' + n: path / n for n in state['ignored']}
    files.update({'git-metadata/' + n: state['gitdir'] / n for n in state['metadata'] if n != '.'})
    size = sum(p.lstat().st_size for p in files.values() if p.is_file() and not p.is_symlink())
    if size > 2 * 1024**3:
        raise Keep('local metadata exceeds two GiB archive limit')
    if shutil.disk_usage(destination.parent).free < size + 200 * 1024**3:
        raise Keep('archive volume needs its 200 GiB reserve')
    with tarfile.open(destination, 'w') as archive:
        for name, source in sorted(files.items()):
            archive.inodes.clear()  # Store hardlinked files independently.
            archive.add(source, arcname=name, recursive=False)
    with destination.open('rb') as stream:
        os.fsync(stream.fileno())
    with tarfile.open(destination, 'r') as archive:
        members = archive.getmembers()
        if {m.name for m in members} != set(files) or len(members) != len(files):
            raise RuntimeError('Archive inventory differs; original retained')
        for member in members:
            source = files[member.name]
            if member.isfile():
                with source.open('rb') as original, archive.extractfile(member) as saved:
                    if digest(original) != digest(saved):
                        raise RuntimeError('Archive content differs; original retained')
            elif member.issym():
                if os.readlink(source) != member.linkname:
                    raise RuntimeError('Archive link differs; original retained')
            elif not member.isdir():
                raise Keep('unsupported archive member')
    with destination.open('rb') as stream:
        return digest(stream)


def archive_commit(repo, reference, head, root):
    """Copy local history to one independent Git store shared by all retirements."""
    destination = root / 'commits.git'
    if shutil.disk_usage(root).free < 200 * 1024**3:
        raise Keep('archive volume needs its 200 GiB reserve')
    if destination.is_symlink():
        raise Keep('commit archive must not be a symlink')
    if not destination.exists():
        git(root, 'init', '--bare', str(destination))
    if git(destination, 'rev-parse', '--is-bare-repository').strip() != b'true':
        raise Keep('commit archive must be a bare repository')
    if ((destination / 'objects/info/alternates').exists()
            or (destination / 'shallow').exists()
            or any((destination / 'objects/pack').glob('*.promisor'))):
        raise Keep('commit archive must contain independent complete history')
    # Fetch copies objects (unlike a local clone with hardlinks/alternates),
    # checks connectivity, and verifies received pack contents before updating refs.
    command(['/usr/bin/git', '-C', str(destination), '-c', 'fetch.fsckObjects=true',
             '-c', 'core.fsync=committed', '-c', 'gc.auto=0',
             'fetch', '--quiet', '--no-tags', '--no-write-fetch-head',
             '--no-recurse-submodules', '--', str(repo), reference + ':' + reference],
            timeout=1800)
    if git(destination, 'rev-parse', '--verify', reference).decode().strip() != head:
        raise RuntimeError('Archived commit differs; original retained')
    if shutil.disk_usage(root).free < 200 * 1024**3:
        raise Keep('archive volume needs its 200 GiB reserve')
    return str(destination)


def retire(repo, record, state, config, open_prs, branch_prs, now):
    path = Path(record['worktree'])
    root = Path(config['archive_root'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    key = uuid.uuid4().hex
    destination = root / (path.name + '-' + key)
    destination.mkdir(mode=0o700)
    receipt = destination / 'receipt.json'
    reference = 'refs/worktree-recovery/' + key
    report = {'worktree': str(path), 'repository': str(repo), 'HEAD': record['HEAD'],
              'branch': record.get('branch'), 'recovery_ref': reference, 'bytes': state['size'],
              'stage': 'preserving', 'created_at': now}
    preserve_oci.save(receipt, report)
    # Zero old OID requires a new ref. Git GC then cannot drop detached commits.
    git(repo, 'update-ref', reference, record['HEAD'], '0' * len(record['HEAD']))
    if state['local_commit']:
        report['commit_archive'] = archive_commit(repo, reference, record['HEAD'], root)
        preserve_oci.save(receipt, report)
    report['archive_sha256'] = archive_local(path, state, destination / 'local-files.tar')
    latest = next((r for r in worktrees(repo) if r['worktree'] == str(path)), None)
    if latest != record:
        raise Keep('registration changed during preservation')
    branch = record.get('branch', '').removeprefix('refs/heads/')
    pr_reason(record, open_prs, pull_requests(config['github_repository'], branch) if branch else branch_prs, time.time())
    current = checkout_state(repo, record, config, mounts(), time.time())
    if current != state:
        raise Keep('checkout changed during preservation')
    report['stage'] = 'verified'
    preserve_oci.save(receipt, report)
    # Native Git checks cleanliness and locks again. Never pass --force.
    git(repo, 'worktree', 'remove', str(path))
    report['stage'] = 'removed'
    preserve_oci.save(receipt, report)
    return str(receipt)


def sweep(config, apply=False):
    repo = Path(config['repository']).resolve(strict=True)
    roots = worktree_roots(config)
    archive = Path(config['archive_root']).resolve()
    if any(archive.is_relative_to(root) or repo.is_relative_to(root) for root in roots):
        raise ValueError('Worktree root must exclude the main repository and archive')
    state_dir = Path(config['state_dir'])
    state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state_dir / 'worktrees.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        now = time.time()
        report = {'checked_at': now, 'apply': apply, 'status': 'running', 'entries': [], 'errors': []}
        report_path = state_dir / ('last-worktree-run.json' if apply else 'worktree-dry-run.json')
        preserve_oci.save(report_path, report)
        try:
            open_prs = pull_requests(config['github_repository'])
            container_mounts = mounts()
            records = worktrees(repo)
        except Exception as error:
            report.update(status='failed', errors=[type(error).__name__])
            preserve_oci.save(report_path, report)
            raise
        fetched_at = time.time()
        before = shutil.disk_usage(repo).free
        for record in records:
            path = Path(record['worktree'])
            if path.parent not in roots:
                continue
            entry = {'worktree': str(path), 'HEAD': record['HEAD']}
            report['entries'].append(entry)
            try:
                if time.time() - fetched_at > 300:
                    open_prs = pull_requests(config['github_repository'])
                    fetched_at = time.time()
                branch = record.get('branch', '').removeprefix('refs/heads/')
                # Check open PRs before issuing per-branch queries or scanning files.
                if any(p['headRefOid'] == record['HEAD'] or (branch and p['headRefName'] == branch)
                       for p in open_prs):
                    raise Keep('open PR')
                branch_prs = pull_requests(config['github_repository'], branch) if branch else []
                entry['reason'] = pr_reason(record, open_prs, branch_prs, now)
                state = checkout_state(repo, record, config, container_mounts, now)
                entry['bytes'] = state['size']
                entry['status'] = 'eligible'
                if apply:
                    entry['receipt'] = retire(repo, record, state, config, open_prs, branch_prs, now)
                    entry['status'] = 'removed'
            except Keep as error:
                entry.update(status='retained', reason=str(error))
            except Exception as error:
                # Do not log subprocess stderr: auth helpers can include credentials.
                entry.update(status='error', reason=type(error).__name__)
                report['errors'].append(str(path))
            LOG.info('%s: %s (%s)', path.name, entry['status'], entry.get('reason', ''))
            if apply:
                preserve_oci.save(state_dir / 'last-worktree-run.json', report)
        report['root_free_before_bytes'] = before
        report['root_free_after_bytes'] = shutil.disk_usage(repo).free
        report['status'] = 'failed' if report['errors'] else 'success'
        preserve_oci.save(report_path, report)
        return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Remove eligible checkouts (default: report only)')
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(message)s')
    os.umask(0o077)
    report = sweep(json.loads(args.config.read_text()), args.apply)
    counts = {s: sum(e['status'] == s for e in report['entries'])
              for s in ('retained', 'eligible', 'removed', 'error')}
    LOG.info('Worktree cleanup complete: %s', counts)
    return bool(report['errors'])


if __name__ == '__main__':
    raise SystemExit(main())
