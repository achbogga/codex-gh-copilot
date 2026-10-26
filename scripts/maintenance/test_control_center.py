import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

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
