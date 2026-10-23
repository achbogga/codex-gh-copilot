import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('screen_sessions', Path(__file__).with_name('screen_sessions.py'))
sessions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sessions)


class ScreenSessionTests(unittest.TestCase):
    def target(self):
        return {'pid': 123, 'start': 'old', 'screen': '45.example', 'window': '0',
                'home': '/private/state', 'backend': 'copilot', 'controller': False,
                'launcher_process': None, 'thread': {'id': 'exact-thread', 'cwd': '/work with spaces',
                    'model': 'gpt-6.1-sol', 'reasoning_effort': 'max'}}

    def test_resume_names_exact_thread_and_preserves_model_state_and_cwd(self):
        target = self.target()
        args = sessions.launch_arguments(target, {'codex_bin': '/new/codex'})
        self.assertEqual(args[-2:], ['resume', 'exact-thread'])
        self.assertNotIn('--last', args)
        self.assertIn('/work with spaces', args)
        self.assertEqual(args[args.index('--model') + 1], 'gpt-6.1-sol')
        self.assertEqual(args[args.index('--reasoning') + 1], 'max')
        target['backend'] = 'native'
        args = sessions.launch_arguments(target, {'codex_bin': '/new/codex'}, 'Continue verification.')
        self.assertEqual(args[0], '/new/codex')
        self.assertEqual(args[-3:], ['resume', 'exact-thread', 'Continue verification.'])

    def test_busy_detection_uses_live_footer_and_preserves_pending_input(self):
        idle = ': Ask Codex to do anything\n\n GPT-6.1 Sol max\n ? for shortcuts\n'
        self.assertTrue(sessions.empty_composer(idle))
        self.assertFalse(sessions.busy(idle))
        self.assertTrue(sessions.busy('Compacting context (2m, esc to interrupt)\n' + idle))
        self.assertFalse(sessions.empty_composer(idle.replace('Ask Codex to do anything', 'unsent draft')))

    def test_active_goals_restore_before_any_prompt_can_suppress_the_resume_dialog(self):
        for status in ('active', 'blocked'):
            self.assertEqual(sessions.continuation_policy({'status': status}, True, None), (None, None))
            self.assertEqual(sessions.continuation_policy({'status': status}, True, 'Verify handoff.'), (None, 'Verify handoff.'))
        initial, deferred = sessions.continuation_policy(None, True, None)
        self.assertIn('Continue the interrupted user task', initial)
        self.assertIsNone(deferred)
        self.assertEqual(sessions.continuation_policy({'status': 'paused'}, False, 'Continue only the user status request.'),
                         ('Continue only the user status request.', None))

    def test_changed_writer_or_thread_prevents_any_screen_input(self):
        target = self.target()
        with patch.object(sessions, 'alive', return_value=False), patch.object(sessions, 'stuff') as stuff:
            with self.assertRaises(RuntimeError):
                sessions.reload_target(target, {}, Path('/unused'))
            stuff.assert_not_called()
        with (patch.object(sessions, 'alive', return_value=True),
              patch.object(sessions, 'root_thread', return_value={'id': 'another-thread'}),
              patch.object(sessions, 'stuff') as stuff):
            with self.assertRaises(RuntimeError):
                sessions.reload_target(target, {}, Path('/unused'))
            stuff.assert_not_called()

    def test_drafts_and_unfinished_compaction_are_not_destroyed(self):
        target = self.target()
        for text in (': my unsent draft\n', 'Compacting context (2m, esc to interrupt)\n: Ask Codex to do anything\n'):
            with (patch.object(sessions, 'alive', return_value=True),
                  patch.object(sessions, 'root_thread', return_value=target['thread']),
                  patch.object(sessions, 'goal', return_value=None),
                  patch.object(sessions, 'capture', return_value=text),
                  patch.object(sessions, 'stuff') as stuff):
                with self.assertRaises(RuntimeError):
                    sessions.reload_target(target, {}, Path('/unused'), drain_seconds=0)
                stuff.assert_not_called()

    def test_still_running_writer_never_allows_concurrent_resume(self):
        target = self.target()
        with (patch.object(sessions, 'alive', return_value=True),
              patch.object(sessions, 'root_thread', return_value=target['thread']),
              patch.object(sessions, 'goal', return_value=None),
              patch.object(sessions, 'capture', return_value=': Ask Codex to do anything\n'),
              patch.object(sessions.time, 'monotonic', side_effect=[0, 0, 0, 100]),
              patch.object(sessions.time, 'sleep'),
              patch.object(sessions, 'enter_command') as enter):
            with self.assertRaises(RuntimeError):
                sessions.reload_target(target, {}, Path('/unused'))
            self.assertEqual([c.args[1] for c in enter.call_args_list], ['/quit'])


if __name__ == '__main__':
    unittest.main()
