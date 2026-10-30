from pathlib import Path
from contextlib import redirect_stdout
import io
import json
import tempfile
import unittest
from unittest.mock import Mock, patch

import update_all


class ControllerHandoffTests(unittest.TestCase):
    def test_partial_reload_keeps_the_report_and_queues_the_controller(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            config = root / 'config.json'
            config.write_text(json.dumps({'repo': str(root), 'runtime_root': str(root / 'runtimes'),
                                          'codex_bin': '/new/codex', 'copilot_bin': '/new/copilot', 'node_bin': '/new/node'}))
            def run_logged(command, log, environment=None):
                if log.name == 'inventory.log':
                    state = log.parent / 'screens'
                    state.mkdir()
                    (state / 'inventory.json').write_text('[]')
            def run(command, **kwargs):
                if '--apply' in command:
                    state = Path(command[command.index('--state-dir') + 1])
                    (state / 'reload-report.json').write_text(json.dumps({'results': [
                        {'status': 'reload-failed', 'screen': '1.draft', 'reason': 'Pending input'},
                        {'status': 'controller-deferred', 'screen': '2.controller', 'thread_id': 'exact-thread'},
                    ]}))
                    return Mock(returncode=1)
                return Mock(returncode=0)
            with (patch.object(update_all.sys, 'argv', ['update', '--config', str(config)]),
                  patch.object(update_all, 'run_logged', side_effect=run_logged),
                  patch.object(update_all, 'install', return_value={'copilot_sdk': '1.0.28'}),
                  patch.object(update_all.subprocess, 'run', side_effect=run),
                  patch.object(update_all.subprocess, 'check_output', return_value=''),
                  patch.object(update_all, 'queue_controller') as queue,
                  redirect_stdout(io.StringIO())):
                self.assertEqual(update_all.main(), 1)
            report = json.loads(Path((root / 'updates/latest-report.txt').read_text().strip()).read_text())
            self.assertEqual(report['status'], 'updated-with-session-failures')
            self.assertEqual(report['session_reload_exit_code'], 1)
            self.assertEqual(report['runtime']['copilot_sdk'], '1.0.28')
            queue.assert_called_once()

    def test_managed_controller_handoff_waits_and_targets_exact_screen_and_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            report = {'results': [{'status': 'controller-deferred', 'screen': '45.controller',
                                   'thread_id': 'exact-thread', 'window': '2'}]}
            with patch.object(update_all.subprocess, 'Popen', return_value=Mock(pid=321)) as start:
                update_all.queue_controller(state / 'config.json', state / 'screen_sessions.py', state, report)
            args = start.call_args.args[0]
            self.assertIn('--probe-native', args)
            self.assertIn('--wait-controller-idle', args)
            self.assertEqual(args[args.index('--only') + 1], '45.controller')
            self.assertEqual(args[args.index('--controller-thread') + 1], 'exact-thread')
            self.assertEqual(args[args.index('--controller-window') + 1], '2')
            self.assertNotIn('--last', args)
            self.assertTrue(start.call_args.kwargs['start_new_session'])
            self.assertEqual(report['controller_handoff_pid'], 321)

    def test_absent_or_ambiguous_controller_never_starts_a_reloader(self):
        with patch.object(update_all.subprocess, 'Popen') as start:
            update_all.queue_controller(Path('/config'), Path('/script'), Path('/private'), {'results': []})
            with self.assertRaisesRegex(RuntimeError, 'ambiguous'):
                update_all.queue_controller(Path('/config'), Path('/script'), Path('/private'),
                    {'results': [{'status': 'controller-deferred'}, {'status': 'controller-deferred'}]})
            start.assert_not_called()


if __name__ == '__main__':
    unittest.main()
