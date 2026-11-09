"""Use real disposable Git repositories to exercise deletion and preservation."""

import json
import os
from pathlib import Path
import sqlite3
import tarfile
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import worktree_cleanup as cleanup

ORIGINAL_PR_QUERY = cleanup.pull_requests


class WorktreeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        cleanup.git(self.repo, 'init', '-b', 'main')
        cleanup.git(self.repo, 'config', 'user.name', 'Test')
        cleanup.git(self.repo, 'config', 'user.email', 'test@example.invalid')
        (self.repo / 'file').write_text('committed\n')
        (self.repo / '.gitignore').write_text('local-notes\nbazel-bin\n.keep-worktree\n')
        cleanup.git(self.repo, 'add', '.')
        cleanup.git(self.repo, 'commit', '-m', 'initial')
        self.head = cleanup.git(self.repo, 'rev-parse', 'HEAD').decode().strip()
        cleanup.git(self.repo, 'update-ref', 'refs/remotes/origin/main', self.head)
        self.parent = self.root / 'worktrees'
        self.parent.mkdir()
        self.path = self.parent / 'old review'
        cleanup.git(self.repo, 'worktree', 'add', '--detach', str(self.path), self.head)
        self.record = next(r for r in cleanup.worktrees(self.repo) if r['worktree'] == str(self.path))
        self.db = self.root / 'threads.sqlite'
        with sqlite3.connect(self.db) as db:
            db.execute('CREATE TABLE threads (cwd TEXT, archived INTEGER)')
        self.config = {'repository': str(self.repo), 'worktree_root': str(self.parent),
                       'archive_root': str(self.root / 'archive'), 'state_dir': str(self.root / 'state'),
                       'github_repository': 'test/repo', 'protected_paths': [], 'thread_databases': [str(self.db)]}
        self.now = time.time() + 30 * cleanup.DAY
        self.addCleanup(patch.stopall)
        patch.object(cleanup.time, 'time', return_value=self.now).start()
        # Docker/GitHub are external services. Git and filesystem guards are real.
        patch.object(cleanup, 'mounts', return_value=[]).start()
        self.prs = patch.object(cleanup, 'pull_requests', return_value=[]).start()
        patch.object(cleanup.shutil, 'disk_usage', return_value=type('Usage', (), {'free': 500 * 1024**3})()).start()

    def state(self):
        return cleanup.checkout_state(self.repo, self.record, self.config, [], self.now)

    def test_clean_checkout_retired_only_after_archive_and_commit_are_recoverable(self):
        (self.path / 'local-notes').write_text('private ignored notes\n')
        external = self.root / 'outside-cache'
        external.mkdir()
        (external / 'keep').write_text('external data')
        (self.path / 'bazel-bin').symlink_to(external, target_is_directory=True)
        report = cleanup.sweep(self.config, apply=True)
        entry = report['entries'][0]
        self.assertEqual(entry['status'], 'removed', entry)
        self.assertFalse(self.path.exists())
        receipt = json.loads(Path(entry['receipt']).read_text())
        self.assertEqual(receipt['stage'], 'removed')
        self.assertEqual(cleanup.git(self.repo, 'rev-parse', receipt['recovery_ref']).decode().strip(), self.head)
        with tarfile.open(Path(entry['receipt']).parent / 'local-files.tar') as archive:
            self.assertEqual(archive.extractfile('ignored/local-notes').read(), b'private ignored notes\n')
            self.assertTrue(archive.getmember('ignored/bazel-bin').issym())
            self.assertEqual(archive.extractfile('git-metadata/HEAD').read().strip(), self.head.encode())
        self.assertEqual((external / 'keep').read_text(), 'external data')
        restored = self.root / 'restored'
        cleanup.git(self.repo, 'worktree', 'add', '--detach', str(restored), receipt['recovery_ref'])
        self.assertEqual((restored / 'file').read_text(), 'committed\n')

    def test_dirty_untracked_hidden_changes_recent_files_and_keep_marker_are_retained(self):
        for variant in ('dirty', 'untracked', 'assume-unchanged', 'skip-worktree', 'recent', 'keep'):
            with self.subTest(variant=variant):
                cleanup.git(self.path, 'update-index', '--no-assume-unchanged', '--no-skip-worktree', 'file')
                (self.path / 'file').write_text('committed\n')
                (self.path / 'new-file').unlink(missing_ok=True)
                (self.path / '.keep-worktree').unlink(missing_ok=True)
                if variant == 'dirty':
                    (self.path / 'file').write_text('changed\n')
                elif variant == 'untracked':
                    (self.path / 'new-file').write_text('untracked')
                elif variant in ('assume-unchanged', 'skip-worktree'):
                    cleanup.git(self.path, 'update-index', '--' + variant, 'file')
                    (self.path / 'file').write_text('hidden changes')
                elif variant == 'recent':
                    os.utime(self.path / 'file', (self.now, self.now))
                else:
                    (self.path / '.keep-worktree').touch()
                with self.assertRaises(cleanup.Keep):
                    self.state()
                self.assertTrue(self.path.is_dir())

    def test_live_open_file_thread_container_mount_and_git_lock_prevent_removal(self):
        with (self.path / 'file').open() as _stream:
            with self.assertRaisesRegex(cleanup.Keep, 'live process'):
                self.state()
        with self.assertRaisesRegex(cleanup.Keep, 'container'):
            cleanup.checkout_state(self.repo, self.record, self.config, [self.path], self.now)
        with sqlite3.connect(self.db) as db:
            db.execute('INSERT INTO threads VALUES (?, 0)', (str(self.path),))
        with self.assertRaisesRegex(cleanup.Keep, 'unarchived thread'):
            self.state()
        with sqlite3.connect(self.db) as db:
            db.execute('DELETE FROM threads')
        cleanup.git(self.repo, 'worktree', 'lock', str(self.path))
        record = next(r for r in cleanup.worktrees(self.repo) if r['worktree'] == str(self.path))
        with self.assertRaisesRegex(cleanup.Keep, 'locked'):
            cleanup.checkout_state(self.repo, record, self.config, [], self.now)

    def test_local_only_commit_and_unknown_branch_are_preserved(self):
        (self.path / 'file').write_text('unique commit')
        cleanup.git(self.path, 'commit', '-am', 'local-only')
        self.record['HEAD'] = cleanup.git(self.path, 'rev-parse', 'HEAD').decode().strip()
        with self.assertRaisesRegex(cleanup.Keep, 'remote reference'):
            self.state()
        cleanup.git(self.path, 'switch', '-c', 'unfinished')
        report = cleanup.sweep(self.config, apply=True)
        self.assertEqual(report['entries'][0]['status'], 'retained')
        self.assertTrue(self.path.exists())

    def test_closed_pr_is_required_and_open_head_with_different_branch_is_protected(self):
        branch = dict(self.record, branch='refs/heads/feature')
        pr = {'number': 1, 'headRefName': 'feature', 'headRefOid': self.head, 'state': 'CLOSED',
              'closedAt': '2020-01-01T00:00:00Z'}
        self.assertEqual(cleanup.pr_reason(branch, [], [pr], self.now), 'closed PR')
        for changed in (dict(pr, state='OPEN'), dict(pr, closedAt=None),
                        dict(pr, closedAt=datetime_now(self.now))):
            with self.subTest(pr=changed), self.assertRaises(cleanup.Keep):
                cleanup.pr_reason(branch, [], [changed], self.now)
        with self.assertRaisesRegex(cleanup.Keep, 'open PR'):
            cleanup.pr_reason(branch, [dict(pr, headRefName='renamed', state='OPEN')], [pr], self.now)

    def test_dry_run_and_github_failure_do_not_delete(self):
        report = cleanup.sweep(self.config)
        self.assertEqual(report['entries'][0]['status'], 'eligible')
        self.assertTrue(self.path.is_dir())
        self.assertFalse(Path(self.config['archive_root']).exists())
        self.prs.side_effect = RuntimeError('API unavailable')
        with self.assertRaises(RuntimeError):
            cleanup.sweep(self.config, apply=True)
        self.assertTrue(self.path.is_dir())
        report = json.loads((Path(self.config['state_dir']) / 'last-worktree-run.json').read_text())
        self.assertEqual(report['status'], 'failed')

    def test_change_during_archive_and_failed_preservation_keep_original(self):
        actual = cleanup.archive_local
        def changed(*args):
            result = actual(*args)
            (self.path / 'file').write_text('concurrent edit')
            return result
        with patch.object(cleanup, 'archive_local', side_effect=changed):
            result = cleanup.sweep(self.config, apply=True)
        self.assertEqual(result['entries'][0]['status'], 'retained')
        self.assertEqual((self.path / 'file').read_text(), 'concurrent edit')
        (self.path / 'file').write_text('committed\n')
        with patch.object(cleanup, 'archive_local', side_effect=OSError('full archive disk')):
            result = cleanup.sweep(self.config, apply=True)
        self.assertEqual(result['entries'][0]['status'], 'error')
        self.assertTrue(self.path.is_dir())

    def test_native_git_rejects_edit_after_final_check(self):
        actual = cleanup.git
        def concurrent(repo, *args):
            if args[:2] == ('worktree', 'remove'):
                (self.path / 'file').write_text('last moment edit')
            return actual(repo, *args)
        with patch.object(cleanup, 'git', side_effect=concurrent):
            report = cleanup.sweep(self.config, apply=True)
        self.assertEqual(report['entries'][0]['status'], 'error')
        self.assertEqual((self.path / 'file').read_text(), 'last moment edit')

    def test_github_result_limit_fails_closed_and_missing_thread_database_is_an_error(self):
        # Exercise the unmocked query function against bounded synthetic API data.
        with patch.object(cleanup, 'command', return_value=json.dumps([{}] * 100).encode()):
            with self.assertRaisesRegex(RuntimeError, 'truncated'):
                ORIGINAL_PR_QUERY('test/repo', 'feature')
        self.db.unlink()
        report = cleanup.sweep(self.config, apply=True)
        self.assertEqual(report['entries'][0]['status'], 'error')
        self.assertTrue(self.path.is_dir())

    def test_new_thread_database_versions_are_included(self):
        new = self.root / 'state_99.sqlite'
        with sqlite3.connect(new) as db:
            db.execute('CREATE TABLE threads (cwd TEXT, archived INTEGER)')
            db.execute('INSERT INTO threads VALUES (?, 0)', (str(self.path),))
        self.config['thread_databases'] = [str(self.root / '*.sqlite')]
        with self.assertRaisesRegex(cleanup.Keep, 'unarchived thread'):
            self.state()

    def test_recent_metadata_change_is_not_hidden_by_preserved_file_mtime(self):
        # Simulate a newly copied file whose copy operation preserved old mtime.
        original = Path.lstat
        target = self.path / 'file'
        def recent_ctime(path):
            info = original(path)
            if path != target:
                return info
            fields = {key: getattr(info, key) for key in dir(info) if key.startswith('st_')}
            fields.update(st_ctime=self.now, st_ctime_ns=int(self.now * 1e9))
            return SimpleNamespace(**fields)
        with patch.object(Path, 'lstat', recent_ctime), self.assertRaisesRegex(cleanup.Keep, 'recent file'):
            self.state()


def datetime_now(timestamp):
    return cleanup.datetime.datetime.fromtimestamp(timestamp, cleanup.datetime.timezone.utc).isoformat()


if __name__ == '__main__':
    unittest.main()
