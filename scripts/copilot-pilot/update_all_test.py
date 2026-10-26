from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import update_all


class ControllerHandoffTests(unittest.TestCase):
    def test_managed_controller_handoff_waits_and_targets_exact_screen_and_thread(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            report = {'results': [{'status': 'controller-deferred', 'screen': '45.controller',
                                   'thread_id': 'exact-thread'}]}
            with patch.object(update_all.subprocess, 'Popen', return_value=Mock(pid=321)) as start:
                update_all.queue_controller(state / 'config.json', state / 'screen_sessions.py', state, report)
            args = start.call_args.args[0]
            self.assertIn('--probe-native', args)
            self.assertIn('--wait-controller-idle', args)
            self.assertEqual(args[args.index('--only') + 1], '45.controller')
            self.assertEqual(args[args.index('--controller-thread') + 1], 'exact-thread')
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
