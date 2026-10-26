import importlib.util
import json
from pathlib import Path
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

spec = importlib.util.spec_from_file_location('control_center', Path(__file__).with_name('control_center.py'))
center = importlib.util.module_from_spec(spec)
spec.loader.exec_module(center)


class ControlCenterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.rollout = self.root / 'rollout.jsonl'
        self.rollout.write_text('')
        self.goal = {'goal_id': 'goal', 'status': 'blocked', 'tokens_used': 300, 'token_budget': None}
        self.target = {'pid': 123, 'start': 'start', 'screen': '45.example', 'window': '0',
                       'home': str(self.root), 'backend': 'copilot', 'controller': False,
                       'goal': self.goal, 'thread': {'id': 'thread', 'model': 'gpt-6.1-sol',
                       'reasoning_effort': 'max', 'cwd': str(self.root), 'rollout_path': str(self.rollout)}}
        self.row = {'screen': '45.example', 'window': '0', 'pid': 123, 'thread_id': 'thread',
                    'verified': True, 'target': self.target}
        self.config = {'state_dir': str(self.root / 'recovery'), 'codex_home': str(self.root),
                       'thread_id': 'thread', 'goal_id': 'goal'}

    def test_busy_user_turn_is_visible_even_while_native_goal_remains_blocked(self):
        evidence = {'started_at': 11, 'completion': {'at': 10, 'failed': False}}
        self.assertEqual(center.state_for(self.goal, evidence), 'working')
        evidence['started_at'] = 9
        self.assertEqual(center.state_for(self.goal, evidence), 'blocked')
        evidence['completion'].update({'failed': True, 'failure_code': 'CONTEXT_WINDOW_EXCEEDED'})
        self.assertEqual(center.state_for(self.goal, evidence), 'overflow')
        self.assertEqual(center.context_text({'state': 'overflow', 'evidence': {'input_tokens': 0}}), 'OVERFLOW')
        self.assertEqual(center.state_for({**self.goal, 'status': 'paused'}, evidence), 'paused')

    def test_snapshot_keeps_unverified_screens_visible_and_caches_unchanged_metadata(self):
        with (patch.object(center.subprocess, 'run') as run,
              patch.object(center.screens, 'inventory', return_value=[self.target]),
              patch.object(center.screens, 'capture', return_value=': Ask Codex to do anything\n'),
              patch.object(center, 'watch_configs', return_value={}),
              patch.object(center.recovery, 'rollout_evidence', return_value={}) as read):
            run.return_value.stdout = ' 45.example (Detached)\n 46.shell (Attached)\n'
            collector = center.Collector()
            rows = collector.snapshot()
            collector.snapshot()
        self.assertEqual(len(rows), 2)
        self.assertTrue(rows[0]['verified'])
        self.assertEqual(rows[1]['state'], 'unverified')
        read.assert_called_once()
        self.assertNotIn('target', center.public_rows(rows)[0])
        self.assertIn('gpt-6.1-sol max', center.text_table(rows))

    def test_credit_totals_in_json_and_visible_at_left_of_model_with_seat_budget_on_top(self):
        billing = Mock()
        billing.sessions.return_value = {'thread': {'text': '12.34+', 'nano_aiu': 12340000000,
                                                   'partial': True, 'reported_calls': 2, 'native_calls': 3}}
        row = {**self.row, 'backend': 'copilot', 'model': 'gpt-6.1-sol', 'reasoning': 'max',
               'goal': self.goal, 'evidence': {}, 'watch': None, 'state': 'working'}
        rows = [row, {**row, 'thread_id': 'native-thread', 'backend': 'native'},
                {**row, 'thread_id': None, 'verified': False}]
        collector = center.Collector(billing)
        self.addCleanup(collector.captures.cleanup)
        collector.add_credits(rows)
        public = center.public_rows(rows)
        self.assertEqual(public[0]['copilot_credits']['text'], '12.34+')
        self.assertEqual(public[1]['copilot_credits']['text'], 'n/a')
        self.assertEqual(public[2]['copilot_credits']['text'], '-')
        self.assertNotIn('target', json.dumps(public))
        table = center.text_table(rows, {'state': 'available', 'unit': 'AI credits',
                                        'used': 123, 'entitlement': 456})
        self.assertIn('123 / 456', table.splitlines()[1])
        line = center.table_row(row)
        self.assertLess(line.index('12.34+'), 65)
        self.assertLess(line.index('12.34+'), line.index('gpt-6.1-sol'))

    def test_missing_billing_database_does_not_disable_control_center(self):
        billing = Mock();billing.sessions.side_effect = OSError('not readable')
        rows = [{**self.row, 'backend': 'copilot'}]
        collector = center.Collector(billing)
        self.addCleanup(collector.captures.cleanup)
        collector.add_credits(rows)
        self.assertEqual(rows[0]['copilot_credits']['state'], 'unavailable')

    def test_slow_billing_refresh_does_not_block_keyboard_and_read_only_controls_stay_disabled(self):
        started, release = threading.Event(), threading.Event()
        billing = Mock()
        def refresh(rows):
            started.set()
            release.wait(timeout=2)
        billing.refresh.side_effect = refresh
        billing.account.return_value = {'state': 'available', 'unit': 'AI credits', 'used': 12, 'entitlement': 34}
        row = {**self.row, 'attachment': 'Detached', 'goal': self.goal, 'evidence': {}, 'watch': None,
               'model': 'model', 'reasoning': 'max', 'state': 'working', 'copilot_credits': {'text': '1.23+'}}
        collector = Mock();collector.snapshot.return_value = [row]
        window = Mock();window.getmaxyx.return_value = (30, 120)
        keys = iter((ord('c'), ord('q')))
        def getch():
            self.assertTrue(started.wait(timeout=1))
            key = next(keys)
            if key == ord('q'):
                release.set()
            return key
        window.getch.side_effect = getch
        args = SimpleNamespace(billing=billing, interval=2, read_only=True,
                               state_root=self.root, config=self.root / 'unused.json')
        with (patch.object(center, 'Collector', return_value=collector), patch.object(center, 'draw_line') as draw,
              patch.object(center.curses, 'curs_set'), patch.object(center, 'act') as act):
            center.interactive(window, args)
        act.assert_not_called()
        self.assertEqual(window.getch.call_count, 2)
        text = '\n'.join(str(call.args[2]) for call in draw.call_args_list)
        self.assertIn('12 / 34', text)
        self.assertIn('1.23+', text)
        self.assertIn('Read-only mode; no native input submitted.', text)

    def test_stale_or_corrupt_watch_report_cannot_appear_healthy(self):
        state = Path(self.config['state_dir']);state.mkdir()
        for value in ({'checked_at': '2000-01-01T00:00:00+00:00', 'status': 'goal-active'},
                      {'checked_at': '2099-01-01T00:00:00+00:00', 'status': 'goal-active'}, {}):
            (state / 'latest.json').write_text(json.dumps(value))
            with (patch.object(center.subprocess, 'run') as run,
                  patch.object(center.screens, 'inventory', return_value=[self.target]),
                  patch.object(center.screens, 'capture', return_value=': Ask Codex to do anything\n'),
                  patch.object(center, 'watch_configs', return_value={(str(self.root), 'thread'): self.config}),
                  patch.object(center.recovery, 'rollout_evidence', return_value={})):
                run.return_value.stdout = ' 45.example (Detached)\n'
                self.assertTrue(center.Collector().snapshot()[0]['watch']['stale'])

    def test_live_terminal_disambiguates_a_long_turn_when_start_metadata_is_outside_tail(self):
        with (patch.object(center.subprocess, 'run') as run,
              patch.object(center.screens, 'inventory', return_value=[self.target]),
              patch.object(center.screens, 'capture', return_value='Working (8m, esc to interrupt)\n: Ask Codex to do anything\n'),
              patch.object(center, 'watch_configs', return_value={}),
              patch.object(center.recovery, 'rollout_evidence', return_value={})):
            run.return_value.stdout = ' 45.example (Detached)\n'
            self.assertEqual(center.Collector().snapshot()[0]['state'], 'working')

    def test_no_screen_daemon_and_terminal_control_text_are_handled(self):
        with patch.object(center.subprocess, 'run') as run, patch.object(center.screens, 'inventory') as inventory:
            run.return_value.stdout = 'No Sockets found.'
            self.assertEqual(center.Collector().snapshot(), [])
            inventory.assert_not_called()
        self.assertNotIn('\x1b', center.clean('\x1b[31msecret\nline'))
        for value in (None, float('nan'), float('inf'), -1, True):
            self.assertEqual(center.short_number(value), '-')

    def test_changed_or_reused_writer_and_unverified_rows_refuse_control(self):
        for change in ({'pid': 124}, {'start': 'reused'}, {'thread': {**self.target['thread'], 'id': 'other'}}):
            with patch.object(center.screens, 'inventory', return_value=[{**self.target, **change}]):
                with self.assertRaises(RuntimeError):
                    center.current_target(self.row)
        with self.assertRaises(RuntimeError):
            center.current_target({**self.row, 'verified': False})

    def test_explicit_reload_can_identify_an_unverified_screen_without_guessing_its_thread(self):
        row = {'screen': '45.example', 'window': '0', 'verified': False}
        with patch.object(center.screens, 'inventory', return_value=[self.target]) as inventory:
            self.assertEqual(center.current_target(row, status_directory=self.root), self.target)
        self.assertEqual(inventory.call_args.kwargs,
                         {'status_directory': self.root, 'status_screen': ('45.example', '0')})
        for targets in ([], [self.target, self.target]):
            with patch.object(center.screens, 'inventory', return_value=targets), self.assertRaises(RuntimeError):
                center.current_target(row, status_directory=self.root)

    def test_reload_probe_still_rejects_a_changed_previously_verified_thread(self):
        changed = {**self.target, 'thread': {**self.target['thread'], 'id': 'other'}}
        with patch.object(center.screens, 'inventory', return_value=[changed]), self.assertRaises(RuntimeError):
            center.current_target(self.row, status_directory=self.root)

    def run_action(self, action, text, *, goal=None, screens=None, after=None):
        with (patch.object(center, 'current_target', return_value=self.target),
              patch.object(center, 'recovery_config', return_value=self.config),
              patch.object(center.screens, 'capture', side_effect=screens or [text]),
              patch.object(center.screens, 'goal', side_effect=[goal or self.goal, after or goal or self.goal]),
              patch.object(center.screens, 'alive', return_value=True),
              patch.object(center.screens, 'stuff') as stuff,
              patch.object(center.time, 'sleep')):
            result = center.act(self.row, action, self.root, self.root / 'update.json')
        return result, [call.args[1] for call in stuff.call_args_list]

    def test_drafts_and_running_compaction_are_preserved_for_every_mutating_control(self):
        for action in ('pause', 'resume', 'compact', 'reload'):
            for screen in (': unfinished draft\n',
                           'Compacting context (esc to interrupt)\n: Ask Codex to do anything\n'):
                result, calls = self.run_action(action, screen)
                self.assertEqual(calls, [])
                self.assertTrue('preserved' in result or 'uninterrupted' in result)

    def test_explicit_resume_respects_terminal_goal_states_and_native_budget(self):
        idle = ': Ask Codex to do anything\n'
        for change in ({'status': 'active'}, {'status': 'complete'}, {'status': 'usage_limited'}, {'token_budget': 200}):
            _, calls = self.run_action('resume', idle, goal={**self.goal, **change})
            self.assertEqual(calls, [])

    def test_compaction_submits_only_native_slash_command_and_separate_enter(self):
        idle = ': Ask Codex to do anything\n'
        result, calls = self.run_action('compact', idle, screens=[idle, ': /compact\n'])
        self.assertEqual(calls, ['/compact', '\r'])
        self.assertIn('verified native session', result)

    def test_manual_resume_of_real_project_block_is_not_gated_only_by_context_size(self):
        idle = ': Ask Codex to do anything\n'
        self.config['compact_after_transport_failure'] = True
        evidence = {'input_tokens': 700000, 'context_window': 997500,
                    'completion': {'failed': False, 'failure_code': None}}
        with patch.object(center.recovery, 'rollout_evidence', return_value=evidence):
            result, calls = self.run_action('resume', idle, screens=[idle, ': /goal resume\n'])
        self.assertEqual(calls, ['/goal resume', '\r'])
        self.assertIn('submitted', result)
        evidence['completion'] = {'failed': True, 'failure_code': 'CONTEXT_WINDOW_EXCEEDED'}
        with patch.object(center.recovery, 'rollout_evidence', return_value=evidence):
            result, calls = self.run_action('resume', idle)
        self.assertEqual(calls, [])
        self.assertIn('needs compaction', result)

    def test_goal_change_or_composer_edit_after_typing_prevents_enter(self):
        idle = ': Ask Codex to do anything\n'
        _, calls = self.run_action('compact', idle, screens=[idle, ': /compact\n'], after={**self.goal, 'goal_id': 'other'})
        self.assertEqual(calls, ['/compact'])
        _, calls = self.run_action('compact', idle, screens=[idle, ': user editing\n'])
        self.assertEqual(calls, ['/compact'])

    def test_control_cannot_compete_with_the_existing_automatic_watcher(self):
        state = Path(self.config['state_dir']);state.mkdir()
        with (state / 'watch.lock').open('a') as lock:
            center.fcntl.flock(lock, center.fcntl.LOCK_EX | center.fcntl.LOCK_NB)
            with patch.object(center, 'current_target', return_value=self.target), patch.object(center, 'recovery_config', return_value=self.config):
                self.assertIn('watcher is busy', center.act(self.row, 'recover', self.root, self.root / 'update.json'))


if __name__ == '__main__':
    unittest.main()
