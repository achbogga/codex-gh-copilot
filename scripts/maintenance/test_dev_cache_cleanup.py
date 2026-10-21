import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
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
    def run_cleanup(self, free, full_log=False):
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
                       patch('sys.argv', ['cleanup', '--pressure'])]
            from contextlib import ExitStack
            with ExitStack() as stack:
                active = [stack.enter_context(p) for p in patches]
                if full_log:
                    stack.enter_context(patch.object(cleanup.logging.handlers, 'RotatingFileHandler', side_effect=OSError(28, 'full')))
                result = cleanup.main()
                marker = (state / 'last-pressure-run.txt').read_text()
                return result, marker, active[4].call_count

    def test_healthy_pressure_check_is_cheap_and_records_a_heartbeat(self):
        result, marker, docker_calls = self.run_cleanup(100 * 1024**3)
        self.assertEqual(result, 0)
        self.assertIn('healthy', marker)
        self.assertEqual(docker_calls, 0)

    def test_low_space_is_not_reported_as_success_and_full_logs_do_not_block_cleanup(self):
        result, marker, docker_calls = self.run_cleanup(0, full_log=True)
        self.assertEqual(result, 1)
        self.assertIn('failed', marker)
        self.assertEqual(docker_calls, 1)


if __name__ == '__main__':
    unittest.main()
