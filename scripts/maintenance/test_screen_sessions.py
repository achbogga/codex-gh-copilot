import importlib.util
from pathlib import Path
import unittest
from unittest.mock import Mock, patch

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

    def test_status_probe_reads_the_existing_clients_exact_thread_without_a_model_prompt(self):
        identifier = '11111111-2222-3333-4444-555555555555'
        idle = ': Ask Codex to do anything\n'
        status = f'/status\n  Session: {identifier}\n' + idle
        with (patch.object(sessions, 'alive', return_value=True),
              patch.object(sessions, 'capture', side_effect=[idle, ': /status\n', status]),
              patch.object(sessions.time, 'sleep'), patch.object(sessions, 'stuff') as stuff):
            self.assertEqual(sessions.probe_status_thread(self.target(), Path('/private')), identifier)
        self.assertEqual([c.args[1] for c in stuff.call_args_list], ['/status', '\r'])

    def test_status_probe_preserves_drafts_compaction_and_reused_processes(self):
        idle = ': Ask Codex to do anything\n'
        for text in (': unfinished draft\n', 'Compacting context\n' + idle):
            with (patch.object(sessions, 'alive', return_value=True),
                  patch.object(sessions, 'capture', return_value=text), patch.object(sessions, 'stuff') as stuff):
                self.assertIsNone(sessions.probe_status_thread(self.target(), Path('/private')))
                stuff.assert_not_called()
        with patch.object(sessions, 'alive', return_value=False), patch.object(sessions, 'stuff') as stuff:
            self.assertIsNone(sessions.probe_status_thread(self.target(), Path('/private')))
            stuff.assert_not_called()

    def test_status_probe_never_submits_over_a_concurrent_composer_edit_or_guesses_missing_id(self):
        idle = ': Ask Codex to do anything\n'
        for changed in (': user edited /status\n', idle):
            with (patch.object(sessions, 'alive', return_value=True),
                  patch.object(sessions, 'capture', side_effect=[idle, changed]),
                  patch.object(sessions.time, 'sleep'), patch.object(sessions, 'stuff') as stuff):
                self.assertIsNone(sessions.probe_status_thread(self.target(), Path('/private')))
                self.assertEqual([c.args[1] for c in stuff.call_args_list], ['/status'])
        with (patch.object(sessions, 'alive', return_value=True),
              patch.object(sessions, 'capture', side_effect=[idle, ': /status\n'] + [idle]*8),
              patch.object(sessions.time, 'sleep'), patch.object(sessions, 'stuff')):
            self.assertIsNone(sessions.probe_status_thread(self.target(), Path('/private')))

    def test_managed_client_identity_is_revalidated_before_quitting(self):
        target = {**self.target(), 'backend': 'native', 'identity_source': 'screen-status'}
        with (patch.object(sessions, 'alive', return_value=True),
              patch.object(sessions, 'probe_status_thread', return_value='other-thread'),
              patch.object(sessions, 'root_thread') as root,
              patch.object(sessions, 'enter_command') as enter):
            with self.assertRaisesRegex(RuntimeError, 'live thread changed'):
                sessions.reload_target(target, {}, Path('/private'))
            root.assert_not_called();enter.assert_not_called()
        with (patch.object(sessions, 'probe_status_thread', return_value='exact-thread'),
              patch.object(sessions, 'root_thread', return_value=target['thread']) as root):
            self.assertEqual(sessions.verified_thread(target, Path('/private')), target['thread'])
            root.assert_called_once_with(Path('/private/state'), 123, 'exact-thread')

    def test_failed_status_probe_never_binds_an_unrelated_tui_to_the_controller(self):
        proc = Mock();proc.name = '123';proc.stat.return_value.st_uid = sessions.os.getuid()
        info = {'pid': 123, 'start': 'same', 'screen': '45.example', 'window': '0', 'home': '',
                'parent': 45, 'args': ['/new/codex']}
        with (patch.object(sessions.Path, 'iterdir', return_value=iter([proc])),
              patch.object(sessions, 'command', return_value=' 45.example (Detached)\n'),
              patch.object(sessions, 'process', return_value=info),
              patch.object(sessions, 'root_thread', return_value=None) as root,
              patch.object(sessions, 'probe_status_thread', return_value=None)):
            self.assertEqual(sessions.inventory('controller-thread', status_directory=Path('/private')), [])
            root.assert_called_once_with(Path.home() / '.codex', 123)

    def test_thread_recovery_overrides_survive_reload_without_affecting_other_sessions(self):
        target = self.target()
        overrides = {'model_auto_compact_token_limit': 750000,
                     'model_providers.copilot-pilot.stream_max_retries': 0}
        config = {'codex_bin': '/new/codex', 'thread_recovery_overrides': {'exact-thread': overrides}}
        args = sessions.launch_arguments(target, config)
        self.assertIn('model_auto_compact_token_limit=750000', args)
        self.assertIn('model_providers.copilot-pilot.stream_max_retries=0', args)
        self.assertEqual(args[-2:], ['resume', 'exact-thread'])
        target['thread']['id'] = 'unrelated-thread'
        self.assertNotIn('model_auto_compact_token_limit=750000', sessions.launch_arguments(target, config))

    def test_recovery_overrides_reject_unsafe_or_malformed_settings(self):
        for overrides in ({'model_providers.copilot-pilot.base_url': 'http://unapproved'},
                          {'model_auto_compact_token_limit': 0},
                          {'model_auto_compact_token_limit': True},
                          {'model_providers.copilot-pilot.stream_max_retries': 99}):
            with self.subTest(overrides=overrides), self.assertRaises(RuntimeError):
                sessions.launch_arguments(self.target(), {'thread_recovery_overrides': {'exact-thread': overrides}})

    def test_invalid_recovery_config_never_quits_the_old_writer(self):
        target = self.target()
        config = {'thread_recovery_overrides': {'exact-thread': {'model_auto_compact_token_limit': 0}}}
        with (patch.object(sessions, 'alive', return_value=True),
              patch.object(sessions, 'root_thread', return_value=target['thread']),
              patch.object(sessions, 'enter_command') as enter):
            with self.assertRaises(RuntimeError):
                sessions.reload_target(target, config, Path('/unused'), drain_seconds=0)
            enter.assert_not_called()

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
