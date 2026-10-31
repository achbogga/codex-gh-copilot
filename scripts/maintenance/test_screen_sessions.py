import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('screen_sessions', Path(__file__).with_name('screen_sessions.py'))
sessions = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sessions)


class ScreenSessionTests(unittest.TestCase):
    def test_verified_native_editor_thread_is_a_root_but_subagents_are_not(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory)
            database = home / 'state_5.sqlite'
            with sqlite3.connect(database) as connection:
                connection.execute('CREATE TABLE threads (id TEXT, source TEXT, cwd TEXT, model TEXT, reasoning_effort TEXT, rollout_path TEXT)')
                connection.executemany('INSERT INTO threads VALUES (?,?,?,?,?,?)', [
                    ('editor-root', 'vscode', '/work', 'gpt-6-astra', 'max', '/rollout-editor.jsonl'),
                    ('cli-root', 'cli', '/work', 'gpt-6.1-sol', 'max', '/rollout-cli.jsonl'),
                    ('child', '{"sub_agent":{"thread_spawn":{"parent_thread_id":"editor-root"}}}',
                     '/work', 'gpt-6-astra', 'max', '/rollout-child.jsonl'),
                ])
            original = database.read_bytes()
            for identifier in ('editor-root', 'cli-root', 'child', 'unknown'):
                with patch.object(sessions.Path, 'iterdir', return_value=iter([])):
                    found = sessions.root_thread(home, 123, identifier)
                if identifier in ('editor-root', 'cli-root'):
                    self.assertEqual(found['id'], identifier)
                else:
                    self.assertIsNone(found)
            with (patch.object(sessions.Path, 'iterdir', return_value=iter([Path('/fd/1'), Path('/fd/2')])),
                  patch.object(sessions.os, 'readlink', side_effect=['/rollout-editor.jsonl', '/rollout-cli.jsonl'])):
                with self.assertRaisesRegex(RuntimeError, 'Multiple root threads'):
                    sessions.root_thread(home, 123)
            with (patch.object(sessions.Path, 'iterdir', return_value=iter([Path('/fd/1'), Path('/fd/2')])),
                  patch.object(sessions.os, 'readlink', side_effect=['/rollout-editor.jsonl', '/rollout-cli.jsonl'])):
                self.assertEqual(sessions.root_thread(home, 123, 'editor-root', verified=True)['id'], 'editor-root')
            self.assertEqual(database.read_bytes(), original)

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

    def test_controller_waits_passively_for_two_idle_captures_before_probing(self):
        idle = ': Ask Codex to do anything\n'
        with (patch.object(sessions, 'capture', side_effect=[
                'Working (1m, esc to interrupt)\n' + idle, idle, ': user draft\n', idle, idle]) as capture,
              patch.object(sessions.time, 'sleep'), patch.object(sessions, 'stuff') as stuff):
            sessions.wait_for_idle_screen(self.target(), Path('/private'))
        self.assertEqual(capture.call_count, 5)
        stuff.assert_not_called()

    def test_idle_footer_cannot_end_an_unfinished_native_controller_turn(self):
        def event(kind, identifier):
            return json.dumps({'type': 'event_msg', 'payload': {'type': kind, 'turn_id': identifier}}) + '\n'
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rollout.jsonl'
            for newer in (False, True):
                path.write_text(event('task_started', 'expected') + (event('task_complete', 'expected') + event('task_started', 'newer') if newer else event('task_complete', 'unrelated')))
                sleeps = 0
                def sleep(_seconds):
                    nonlocal sleeps
                    sleeps += 1
                    if sleeps == 2:
                        with path.open('a') as output:
                            output.write(event('task_complete', 'newer' if newer else 'expected'))
                with (patch.object(sessions, 'capture', return_value=': Ask Codex to do anything\n') as capture,
                      patch.object(sessions.time, 'sleep', side_effect=sleep),
                      patch.object(sessions, 'stuff') as stuff):
                    sessions.wait_for_idle_screen(self.target(), Path(directory), path, 'expected')
                self.assertEqual(capture.call_count, 4)
                stuff.assert_not_called()

    def test_controller_lifecycle_reader_retains_partial_records(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rollout.jsonl'
            started = json.dumps({'type': 'event_msg', 'payload': {'type': 'task_started', 'turn_id': 'turn'}})
            completed = json.dumps({'type': 'event_msg', 'payload': {'type': 'task_complete', 'turn_id': 'turn'}})
            path.write_text(started + '\n' + completed)
            with path.open('rb') as source:
                self.assertEqual(list(sessions.turn_events(source)), [('task_started', 'turn')])
                self.assertEqual(list(sessions.turn_events(source)), [])
                with path.open('a') as output:
                    output.write('\n')
                self.assertEqual(list(sessions.turn_events(source)), [('task_complete', 'turn')])
            self.assertEqual(sessions.latest_turn(path), 'turn')
            path.write_text('')
            with self.assertRaisesRegex(RuntimeError, 'no recorded native turn'):
                sessions.latest_turn(path)

    def test_interrupted_controller_turn_cancels_automatic_handoff(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'rollout.jsonl'
            path.write_text(''.join(json.dumps({'type': 'event_msg', 'payload': {
                'type': kind, 'turn_id': 'expected'}}) + '\n' for kind in ('task_started', 'turn_aborted')))
            with patch.object(sessions, 'stuff') as stuff, patch.object(sessions, 'capture') as capture:
                with self.assertRaisesRegex(RuntimeError, 'automatic handoff cancelled'):
                    sessions.wait_for_idle_screen(self.target(), Path(directory), path, 'expected')
                stuff.assert_not_called()
                capture.assert_not_called()

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
        for text in (': unfinished draft\n', 'Compacting context\n' + idle,
                     'This conversation is open in another app\n' + idle):
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
                  patch.object(sessions, 'capture', side_effect=[idle] + [changed]*20),
                  patch.object(sessions.time, 'sleep'), patch.object(sessions, 'stuff') as stuff):
                self.assertIsNone(sessions.probe_status_thread(self.target(), Path('/private')))
                self.assertEqual([c.args[1] for c in stuff.call_args_list], ['/status'])
        with (patch.object(sessions, 'alive', return_value=True),
              patch.object(sessions, 'capture', side_effect=[idle, ': /status\n'] + [idle]*8),
              patch.object(sessions.time, 'sleep'), patch.object(sessions, 'stuff')):
            self.assertIsNone(sessions.probe_status_thread(self.target(), Path('/private')))

    def test_status_probe_waits_for_delayed_screen_rendering_before_enter(self):
        identifier = '11111111-2222-3333-4444-555555555555'
        idle = ': Ask Codex to do anything\n'
        with (patch.object(sessions, 'alive', return_value=True),
              patch.object(sessions, 'capture', side_effect=[idle, idle, idle, ': /status\n',
                                                            f'Session: {identifier}\n' + idle]),
              patch.object(sessions.time, 'sleep'), patch.object(sessions, 'stuff') as stuff):
            self.assertEqual(sessions.probe_status_thread(self.target(), Path('/private')), identifier)
        self.assertEqual([c.args[1] for c in stuff.call_args_list], ['/status', '\r'])

    def test_explicit_probe_identifies_native_and_copilot_clients_without_rollout_descriptors(self):
        for backend in ('native', 'copilot'):
            with self.subTest(backend=backend):
                proc = Mock();proc.name = '123';proc.stat.return_value.st_uid = sessions.os.getuid()
                info = {'pid': 123, 'start': 'same', 'screen': '45.example', 'window': '0', 'home': '/private/state',
                        'parent': 99 if backend == 'copilot' else 45, 'args': ['/new/codex']}
                launcher = {'pid': 99, 'start': 'launcher', 'parent': 45, 'args': ['node', '/repo/host-run.mjs']}
                thread = self.target()['thread']
                with (patch.object(sessions.Path, 'iterdir', return_value=iter([proc])),
                      patch.object(sessions, 'command', return_value=' 45.example (Detached)\n'),
                      patch.object(sessions, 'process', side_effect=lambda pid: info if pid == 123 else launcher),
                      patch.object(sessions, 'root_thread', side_effect=[None, thread]) as root,
                      patch.object(sessions, 'goal', return_value=None),
                      patch.object(sessions, 'probe_status_thread', return_value=thread['id'])):
                    result = sessions.inventory(status_directory=Path('/private'), only='example')
                self.assertEqual(len(result), 1)
                self.assertEqual(result[0]['backend'], backend)
                self.assertEqual(result[0]['identity_source'], 'screen-status')
                self.assertEqual(result[0]['thread']['id'], thread['id'])
                root.assert_called_with(Path('/private/state'), 123, thread['id'], verified=True)

    def test_targeted_inventory_does_not_probe_another_screen(self):
        proc = Mock();proc.name = '123';proc.stat.return_value.st_uid = sessions.os.getuid()
        info = {'pid': 123, 'screen': '45.example', 'args': ['/new/codex']}
        with (patch.object(sessions.Path, 'iterdir', return_value=iter([proc])),
              patch.object(sessions, 'command', return_value=' 45.example (Detached)\n'),
              patch.object(sessions, 'process', return_value=info),
              patch.object(sessions, 'probe_status_thread') as probe):
            self.assertEqual(sessions.inventory(status_directory=Path('/private'), only='other'), [])
            probe.assert_not_called()

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
            root.assert_called_once_with(Path('/private/state'), 123, 'exact-thread', verified=True)

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
        overrides = {'model_auto_compact_token_limit': 600000,
                     'model_providers.copilot-pilot.stream_max_retries': 1}
        config = {'codex_bin': '/new/codex', 'thread_recovery_overrides': {'exact-thread': overrides}}
        args = sessions.launch_arguments(target, config)
        self.assertIn('model_auto_compact_token_limit=600000', args)
        self.assertIn('model_providers.copilot-pilot.stream_max_retries=1', args)
        self.assertEqual(args[-2:], ['resume', 'exact-thread'])
        target['thread']['id'] = 'unrelated-thread'
        self.assertNotIn('model_auto_compact_token_limit=600000', sessions.launch_arguments(target, config))

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

    def test_native_ownership_retry_waits_without_forking_or_probing_the_notice(self):
        target = self.target()
        target['backend'] = 'native'
        replacement = {**target, 'pid': 456, 'start': 'new'}
        idle = ': Ask Codex to do anything\n'
        with (patch.object(sessions, 'alive', side_effect=[True, True, False]),
              patch.object(sessions, 'verified_thread', return_value=target['thread']),
              patch.object(sessions, 'goal', return_value=None),
              patch.object(sessions, 'capture', side_effect=[idle, 'This conversation is open in another app', idle, idle]),
              patch.object(sessions, 'inventory', return_value=[replacement]) as inventory,
              patch.object(sessions, 'enter_command') as enter,
              patch.object(sessions, 'stuff') as stuff,
              patch.object(sessions.time, 'sleep'),
              patch.object(sessions.time, 'monotonic', side_effect=range(10, 100)),
              patch.object(sessions.os, 'readlink', return_value='/new/codex')):
            result = sessions.reload_target(target, {'codex_bin': '/new/codex'}, Path('/private'), drain_seconds=0)
        self.assertEqual(result['status'], 'reloaded-exact-thread')
        self.assertEqual(result['thread_id'], target['thread']['id'])
        self.assertEqual([call.args[1] for call in stuff.call_args_list], ['r'])
        self.assertEqual(inventory.call_count, 2)
        self.assertEqual(enter.call_args_list[0].args[1], '/quit')
        self.assertIn('resume exact-thread', enter.call_args_list[1].args[1])
        self.assertEqual(enter.call_count, 2)

    def test_controller_handoff_refuses_a_changed_thread_or_window(self):
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            config = state / 'config.json'
            config.write_text(json.dumps({}))
            target = self.target()
            for changed in ({**target, 'thread': {**target['thread'], 'id': 'another-thread'}},
                            {**target, 'window': '1'}):
                with (patch.object(sessions.os, 'umask'),
                      patch('sys.argv', ['screen_sessions', '--config', str(config), '--state-dir', str(state),
                                        '--only', target['screen'], '--controller-thread', target['thread']['id'],
                                        '--controller-rollout', '/private/rollout.jsonl', '--controller-turn', 'current-turn',
                                        '--wait-controller-idle', '--apply']),
                      patch.object(sessions, 'wait_for_idle_screen'),
                      patch.object(sessions, 'inventory', return_value=[changed]),
                      patch.object(sessions, 'reload_target') as reload):
                    with self.assertRaisesRegex(RuntimeError, 'Controller thread or window changed'):
                        sessions.main()
                    reload.assert_not_called()

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
