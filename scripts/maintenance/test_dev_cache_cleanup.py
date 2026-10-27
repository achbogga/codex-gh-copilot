import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
import io
import os
from contextlib import redirect_stderr
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "dev_cache_cleanup", Path(__file__).with_name("dev_cache_cleanup.py"))
cleanup = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cleanup)


class DockerCleanupTests(unittest.TestCase):
    def test_digest_only_imports_are_removed_but_tagged_used_and_new_images_stay(self):
        images = {
            'old': {'Id': 'old', 'RepoTags': [], 'RepoDigests': ['registry/base@sha256:old'],
                    'Created': '2020-01-01T00:00:00Z'},
            'tagged': {'Id': 'tagged', 'RepoTags': ['keep:latest'], 'Created': '2020-01-01T00:00:00Z'},
            'used': {'Id': 'used', 'RepoTags': [], 'Created': '2020-01-01T00:00:00Z'},
            'new': {'Id': 'new', 'RepoTags': [], 'Created': '2030-01-01T00:00:00Z'},
        }

        def read(_docker, args):
            if args[:2] == ['image', 'ls']:
                return '\n'.join(images)
            if args[:2] == ['container', 'ls']:
                return 'container'
            if args[:2] == ['container', 'inspect']:
                return json.dumps([{'Image': 'used'}])
            return json.dumps([images[args[-1]]])

        with patch.object(cleanup, 'docker_read', side_effect=read), patch.object(
                cleanup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'Deleted: layer', '')) as run:
            cleanup.docker_untagged_images(['docker', '--host', 'unix:///local'], False, now=1800000000)
        self.assertEqual(run.call_count, 1)
        self.assertEqual(run.call_args.args[0], ['docker', '--host', 'unix:///local', 'image', 'rm', 'registry/base@sha256:old'])
        self.assertNotIn('--force', run.call_args.args[0])

    def test_dry_run_never_removes_images_and_daemon_conflicts_are_preserved(self):
        image = {'Id': 'old', 'RepoTags': [], 'RepoDigests': ['registry/base@sha256:old'],
                 'Created': '2020-01-01T00:00:00Z'}

        def read(_docker, args):
            if args[:2] == ['image', 'ls']:
                return 'old'
            if args[:2] == ['container', 'ls']:
                return ''
            return json.dumps([image])

        with patch.object(cleanup, 'docker_read', side_effect=read), patch.object(
                cleanup.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1, '', 'in use')) as run:
            cleanup.docker_untagged_images(['docker'], True, now=1800000000)
            run.assert_not_called()
            cleanup.docker_untagged_images(['docker'], False, now=1800000000)
            self.assertEqual(run.call_count, 1)


class PressureTests(unittest.TestCase):
    def run_cleanup(self, free, full_log=False, pressure=True):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / '.cache').mkdir()
            state = root / 'state'
            usage = type('Usage', (), {'free': free, 'total': 1000 * 1024**3})()
            patches = [patch.object(cleanup, 'USER_HOME', root),
                       patch.object(cleanup, 'STATE', state),
                       patch.object(cleanup, 'CACHE_ROOTS', []),
                       patch.object(cleanup.shutil, 'disk_usage', return_value=usage),
                       patch.object(cleanup, 'docker_cleanup'),
                       patch.object(cleanup, 'preserve_snapshots'),
                       patch.object(cleanup.preserve_oci, 'pending', return_value=[]),
                       patch('sys.argv', ['cleanup'] + (['--pressure'] if pressure else []))]
            from contextlib import ExitStack
            with ExitStack() as stack:
                active = [stack.enter_context(p) for p in patches]
                if full_log:
                    stack.enter_context(patch.object(cleanup.logging.handlers, 'RotatingFileHandler', side_effect=OSError(28, 'full')))
                stderr = io.StringIO()
                with redirect_stderr(stderr):
                    result = cleanup.main()
                label = 'last-pressure-run' if pressure else 'last-run'
                marker = (state / (label + '.txt')).read_text()
                report = json.loads((state / (label + '.json')).read_text())
                return result, marker, active[4].call_count, active[5].call_count, stderr.getvalue(), report

    def test_healthy_pressure_check_is_cheap_and_records_a_heartbeat(self):
        result, marker, docker_calls, snapshots, stderr, report = self.run_cleanup(130 * 1024**3)
        self.assertEqual(result, 0)
        self.assertIn('healthy', marker)
        self.assertEqual(docker_calls, 0)
        self.assertEqual(snapshots, 0)
        self.assertEqual(stderr, '')
        self.assertEqual(report['root_free_bytes'], 130 * 1024**3)

    def test_low_space_is_not_reported_as_success_and_full_logs_do_not_block_cleanup(self):
        result, marker, docker_calls, snapshots, stderr, report = self.run_cleanup(0, full_log=True)
        self.assertEqual(result, 1)
        self.assertIn('failed', marker)
        self.assertEqual(docker_calls, 1)
        self.assertEqual(snapshots, 1)
        self.assertIn('root-space-remains-low', stderr)
        self.assertEqual(report['status'], 'failed')

    def test_daily_run_also_reports_low_root_space_as_failure(self):
        result, marker, _, snapshots, stderr, report = self.run_cleanup(90 * 1024**3, pressure=False)
        self.assertEqual(result, 1)
        self.assertIn('failed', marker)
        self.assertEqual(snapshots, 1)
        self.assertIn('root-space-remains-low', stderr)

    def test_pressure_starts_before_the_old_eighty_gib_threshold(self):
        result, _, docker, snapshots, _, _ = self.run_cleanup(110 * 1024**3)
        self.assertEqual(result, 1)
        self.assertEqual((docker, snapshots), (1, 1))

    def test_filesystem_filter_is_applied_after_resolving_cache_symlinks(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); local = root / 'local'; remote = root / 'remote'
            local.mkdir();remote.mkdir();alias = root / 'alias';alias.symlink_to(remote)
            original = Path.stat
            device = local.stat().st_dev
            def fake_stat(path, *args, **kwargs):
                info = original(path, *args, **kwargs)
                if path == remote:
                    values = list(info);values[2] = device + 1
                    return os.stat_result(values)
                return info
            with patch.object(Path, 'stat', fake_stat):
                self.assertEqual(list(cleanup.unique_dirs([local, alias], device=device)), [local])
                self.assertEqual(list(cleanup.unique_dirs([remote, alias])), [remote])


if __name__ == '__main__':
    unittest.main()
