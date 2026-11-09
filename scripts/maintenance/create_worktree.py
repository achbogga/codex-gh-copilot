#!/usr/bin/python3
"""Create a native Git worktree in the configured data directory.

Review checkouts require explicit source directories; full checkouts are opt-in.
This prepares source files without launching repository environment hooks/builds.
"""

import argparse
import fcntl
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import time

import preserve_oci
from worktree_cleanup import git, worktree_roots


def create(config, name, ref='HEAD', paths=(), branch=None, full=False):
    """Create a scoped or full checkout without reusing an existing directory."""
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]*', name):
        raise ValueError('Use a single directory name containing letters, numbers, dots, underscores or hyphens')
    if (full and paths) or (not full and not paths):
        raise ValueError('Choose explicit --path directories or --full')
    repo = Path(config['repository']).resolve(strict=True)
    root = Path(config['creation_root']).resolve(strict=True)
    if root not in worktree_roots(config) or repo.is_relative_to(root):
        raise ValueError('Creation directory must be an explicitly managed worktree root')
    destination = root / name
    if os.path.lexists(destination):
        raise FileExistsError(destination)
    if shutil.disk_usage(root).free < config.get('creation_min_free_bytes', 0):
        raise RuntimeError('Worktree filesystem is below its configured free-space reserve')
    head = git(repo, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}').decode().strip()
    selected = sorted(set([*config.get('review_paths', []), *paths])) if not full else []
    for entry in selected:
        path = PurePosixPath(entry)
        if path.is_absolute() or '..' in path.parts or str(path) in ('.', '') or entry.startswith('-'):
            raise ValueError('Sparse paths must be repository-relative directories')
        if git(repo, 'cat-file', '-t', head + ':' + entry).strip() != b'tree':
            raise ValueError('Sparse path is not a directory in the selected commit: ' + entry)
    state = Path(config['state_dir'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'worktrees.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        args = ['worktree', 'add']
        args += ['-b', branch] if branch else ['--detach']
        if not full:
            args.append('--no-checkout')
        git(repo, *args, str(destination), head)
        # On failure, leave the new checkout for inspection; never force-remove it.
        if selected:
            git(destination, 'sparse-checkout', 'set', '--cone', '--no-sparse-index', *selected)
            git(destination, 'read-tree', '-mu', 'HEAD')
        if git(destination, 'status', '--porcelain=v1', '-z', '--untracked-files=all'):
            raise RuntimeError('New checkout is not clean; retained for inspection: ' + str(destination))
        preserve_oci.save(state / f'created-worktree-{time.time_ns()}.json', {
            'path': str(destination), 'HEAD': head, 'branch': branch, 'paths': selected,
            'full': full, 'created_at': time.time(),
        })
    return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('name')
    parser.add_argument('--config', type=Path,
                        default=Path.home() / '.config/dev-cache-cleanup/worktrees.json')
    parser.add_argument('--ref', default='HEAD')
    parser.add_argument('--path', dest='paths', action='append', default=[])
    parser.add_argument('--branch', help='Create a new editing branch (default: detached review checkout)')
    parser.add_argument('--full', action='store_true', help='Opt into a complete checkout for builds/tests')
    args = parser.parse_args()
    os.umask(0o077)
    print(create(json.loads(args.config.read_text()), args.name, args.ref, args.paths, args.branch, args.full))


if __name__ == '__main__':
    main()
