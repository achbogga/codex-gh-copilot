import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery_watch', Path(__file__).with_name('goal_recovery_watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)

EMPTY_SCREEN = '\n: Ask Codex to do anything\n\n GPT-6.1 Sol max Goal stalled (/goal resume)\n ? for shortcuts\n'
PENDING_SCREEN = EMPTY_SCREEN.replace('Ask Codex to do anything', '/goal resume')


class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = {'codex_home': str(self.root), 'thread_id': 'thread',
                       'goal_id': 'goal', 'screen_name': 'fastpath', 'project': str(self.root),
                       'review_at_tokens': 10_000_000}
        self.goal = {'thread_id': 'thread', 'goal_id': 'goal', 'status': 'blocked',
                     'token_budget': None, 'tokens_used': 7_300_000,
                     'time_used_seconds': 12, 'updated_at_ms': 1_000_000}
        self.evidence = {'completion': {'at': 1000, 'failure_code': 'UND_ERR_SOCKET'},
                         'started_at': 900, 'user_message_at': 800, 'tool_result_at': 850}

    def reason(self, goal=None, evidence=None, ledger=None, now=1100):
        return watch.blocked_reason(self.config, goal or self.goal, evidence or self.evidence, ledger or {}, now)

    def test_human_pauses_terminal_states_replaced_goals_and_budgets(self):
        for status in ('active', 'paused', 'complete', 'completed', 'usage_limited'):
            with self.subTest(status=status):
                self.assertIsNotNone(self.reason(goal={**self.goal, 'status': status}))
        self.assertEqual(self.reason(goal={**self.goal, 'goal_id': 'replacement'}), 'goal-absent-or-replaced')
        self.assertEqual(self.reason(goal={**self.goal, 'token_budget': 7_000_000}), 'native-budget-reached')
        self.assertEqual(self.reason(goal={**self.goal, 'tokens_used': 10_000_000}), 'human-strategy-review-required')
        self.assertIsNone(self.reason())

    def test_old_scrollback_real_blockers_and_later_user_activity_cannot_authorize_resume(self):
        self.assertEqual(self.reason(evidence={**self.evidence, 'completion': None}), 'no-confirmed-transport-failure')
        for code in (None, ''):
            self.assertEqual(self.reason(evidence={**self.evidence, 'completion': {'at': 1000, 'failure_code': code}}), 'no-confirmed-transport-failure')
        for change in ({'started_at': 1001}, {'user_message_at': 1001}):
            self.assertEqual(self.reason(evidence={**self.evidence, **change}), 'failure-is-not-current')
        self.assertEqual(self.reason(goal={**self.goal, 'updated_at_ms': 1_100_000}), 'failure-is-not-current')
        self.assertEqual(self.reason(now=1001), 'failure-too-new-or-stale')
        self.assertEqual(self.reason(now=100_000), 'failure-too-new-or-stale')

    def test_attempts_cool_down_and_latch_after_two_failures_without_tool_progress(self):
        self.assertEqual(self.reason(ledger={'consecutive_attempts': 2}), 'recovery-exhausted-needs-review')
        self.assertEqual(self.reason(ledger={'attempts': [{'at': 1050}]}), 'recovery-cooldown')
        self.assertEqual(self.reason(ledger={'attempts': [{'at': -1000}] * 6}), 'daily-recovery-limit')
        self.assertEqual(self.reason(ledger={'last_failure_at': 1000}), 'failure-already-handled')

    def test_exact_failure_classification_excludes_policy_auth_refusal_cancel_and_unknown_errors(self):
        path = self.root / 'rollout.jsonl'
        for message, expected in (
                ('stream disconnected before completion: Copilot stream ended before completion (UND_ERR_SOCKET).', 'UND_ERR_SOCKET'),
                ('stream disconnected before completion: Copilot stream ended before completion (COPILOT_UNEXPECTED_EOF).', 'COPILOT_UNEXPECTED_EOF'),
                ('stream disconnected before completion: Copilot stream ended before completion (ABORT_ERR).', None),
                ('stream disconnected before completion: Copilot stream ended before completion (INVALID_SSE_JSON).', None),
                ('HTTP 403 enterprise policy denied', None), ('HTTP 401 invalid credentials', None),
                ('TLS verification failed', None), ('quota exhausted', None),
                ('reasoning_extraction', None), ('502 Bad Gateway', None),
                ('Your input exceeds the context window of this model.', None)):
            with self.subTest(message=message):
                path.write_text('partial bad JSON\n' + json.dumps({'timestamp': '2026-10-22T18:49:06Z', 'type': 'event_msg',
                               'payload': {'type': 'task_complete', 'error': {'message': message}}}) + '\n')
                self.assertEqual(watch.rollout_evidence(path)['completion']['failure_code'], expected)

    def test_rollout_tail_tracks_later_work_and_does_not_reset_on_reasoning_or_usage(self):
        path = self.root / 'rollout.jsonl'
        events = [('response_item', {'type': 'function_call_output', 'output': 'private'}),
                  ('event_msg', {'type': 'token_count'}),
                  ('event_msg', {'type': 'task_started'}),
                  ('event_msg', {'type': 'user_message', 'message': 'pause'})]
        path.write_text('x' * (watch.TAIL_BYTES + 10) + '\n' + '\n'.join(
            json.dumps({'timestamp': f'2026-10-22T18:49:0{i}Z', 'type': kind, 'payload': payload})
            for i, (kind, payload) in enumerate(events)))
        evidence = watch.rollout_evidence(path)
        self.assertGreater(evidence['started_at'], evidence['tool_result_at'])
        self.assertGreater(evidence['user_message_at'], evidence['started_at'])
        self.assertNotIn('private', json.dumps(evidence))

    def test_read_only_native_queries_do_not_modify_state(self):
        goal_db = self.root / 'goals_1.sqlite'
        thread_db = self.root / 'state_5.sqlite'
        with sqlite3.connect(goal_db) as c:
            c.execute('CREATE TABLE thread_goals (thread_id, goal_id, status, token_budget, tokens_used, time_used_seconds, updated_at_ms)')
            c.execute('INSERT INTO thread_goals VALUES (?,?,?,?,?,?,?)', tuple(self.goal.values()))
        with sqlite3.connect(thread_db) as c:
            c.execute('CREATE TABLE threads (id, rollout_path)')
            c.execute('INSERT INTO threads VALUES (?,?)', ('thread', str(self.root / 'rollout.jsonl')))
        before = [p.read_bytes() for p in (goal_db, thread_db)]
        self.assertEqual(watch.read_native(self.config)[0], self.goal)
        self.assertEqual(before, [p.read_bytes() for p in (goal_db, thread_db)])

    def test_attached_missing_or_ambiguous_screens_are_refused(self):
        for text in ('', ' 123.fastpath (Attached)\n', ' 123.fastpath (Detached)\n 456.fastpath (Detached)\n'):
            with patch.object(watch.subprocess, 'run') as run:
                run.return_value.stdout = text
                with self.assertRaises(RuntimeError):
                    watch.detached_screen('fastpath')
        with patch.object(watch.subprocess, 'run') as run:
            run.return_value.stdout = ' 123.fastpath (10/22/26 00:00:00) (Detached)\n'
            self.assertEqual(watch.detached_screen('fastpath'), '123.fastpath')

    def test_busy_compaction_pending_input_and_dialogs_are_not_interrupted(self):
        self.assertTrue(watch.idle_stalled_prompt(EMPTY_SCREEN))
        for screen in (PENDING_SCREEN, EMPTY_SCREEN.replace('Ask Codex to do anything', 'my unfinished draft'),
                       'Compacting context (13m, esc to interrupt)\n' + EMPTY_SCREEN,
                       'Working (esc to interrupt)\n' + EMPTY_SCREEN,
                       EMPTY_SCREEN.replace('Goal stalled (/goal resume)', 'Goal paused'),
                       'Resume paused goal?\n1 Resume goal\n2 Leave paused\n'):
            self.assertFalse(watch.idle_stalled_prompt(screen))

    def make_proc(self, pid, parent, rollout=None, window='0', foreground=True):
        entry = self.root / 'proc' / str(pid)
        entry.mkdir(parents=True)
        fields = ['S', str(parent), '100', '100', '1', '100' if foreground else '999'] + ['0'] * 14
        fields[19] = '12345'
        (entry / 'stat').write_text(f'{pid} (codex) ' + ' '.join(fields))
        (entry / 'cmdline').write_bytes(b'/installed/bin/codex\0resume\0thread\0')
        (entry / 'environ').write_bytes(f'STY=123.fastpath\0WINDOW={window}\0CODEX_HOME={self.root}\0'.encode())
        (entry / 'fd').mkdir()
        if rollout:
            (entry / 'fd/35').symlink_to(rollout)
        return entry

    def test_native_identity_requires_exact_open_rollout_and_foreground_window_not_just_resume_args(self):
        rollout = self.root / 'rollout-thread.jsonl'
        entry = self.make_proc(456, 123, rollout)
        self.assertEqual(watch.native_identity(self.config, '123.fastpath', rollout, self.root / 'proc'), (456, '12345'))
        for change in ('different-rollout', 'different-window', 'background', 'different-screen-parent'):
            with self.subTest(change=change):
                original = {p.name: p.read_bytes() for p in (entry / 'stat', entry / 'environ')}
                if change == 'different-rollout':
                    (entry / 'fd/35').unlink(); (entry / 'fd/35').symlink_to(self.root / 'rollout-new-thread.jsonl')
                elif change == 'different-window':
                    (entry / 'environ').write_bytes(original['environ'].replace(b'WINDOW=0', b'WINDOW=1'))
                elif change == 'background':
                    (entry / 'stat').write_text((entry / 'stat').read_text().replace('100 100 1 100', '100 100 1 999'))
                else:
                    (entry / 'stat').write_text((entry / 'stat').read_text().replace('S 123 ', 'S 1 '))
                with self.assertRaises(RuntimeError):
                    watch.native_identity(self.config, '123.fastpath', rollout, self.root / 'proc')
                for name, content in original.items():
                    (entry / name).write_bytes(content)
                if change == 'different-rollout':
                    (entry / 'fd/35').unlink(); (entry / 'fd/35').symlink_to(rollout)

    def exercise_check(self, *, apply, native=None, screens=None, ledger=None, started_at=900):
        if ledger:
            (self.root / 'recovery.json').write_text(json.dumps(ledger))
        free = type('Free', (), {'f_bavail': 20 * 1024**3, 'f_frsize': 1})()
        with (patch.object(watch, 'read_native', side_effect=native or [(self.goal, self.root)] * 4),
              patch.object(watch, 'rollout_evidence', return_value=self.evidence),
              patch.object(watch.time, 'time', return_value=1100),
              patch.object(watch.time, 'sleep'),
              patch.object(watch.os, 'statvfs', return_value=free),
              patch.object(watch, 'detached_screen', return_value='123.fastpath'),
              patch.object(watch, 'native_identity', return_value=(456, '12345')),
              patch.object(watch, 'native_started_at', return_value=started_at),
              patch.object(watch, 'capture_screen', side_effect=screens or [EMPTY_SCREEN, EMPTY_SCREEN, PENDING_SCREEN]),
              patch.object(watch.subprocess, 'run') as run):
            result = watch.check(self.config, self.root, apply)
            return result, run.call_args_list

    def test_dry_run_never_sends_input_or_spends_recovery_allowance(self):
        result, calls = self.exercise_check(apply=False)
        self.assertEqual(result['status'], 'would-resume')
        self.assertEqual(calls, [])
        self.assertFalse((self.root / 'recovery.json').exists())

    def test_leave_paused_after_restart_cannot_be_overridden_using_old_failure(self):
        result, calls = self.exercise_check(apply=True, started_at=1050)
        self.assertEqual(result['status'], 'failure-precedes-current-native-process')
        self.assertEqual(calls, [])
        self.assertFalse((self.root / 'recovery.json').exists())

    def test_resume_uses_existing_screen_separate_enter_and_verifies_native_acceptance(self):
        native = [(self.goal, self.root)] * 3 + [({**self.goal, 'status': 'active'}, self.root)]
        result, calls = self.exercise_check(apply=True, native=native)
        self.assertEqual(result['status'], 'resume-accepted')
        self.assertEqual([call.args[0][-1] for call in calls], ['/goal resume', '\r'])
        ledger = json.loads((self.root / 'recovery.json').read_text())
        self.assertEqual(ledger['consecutive_attempts'], 1)
        self.assertEqual(ledger['last_failure_at'], 1000)
        self.assertFalse(any('exec' in call.args[0] for call in calls))

    def test_manual_pause_or_replacement_during_checks_prevents_input(self):
        for change in ({'status': 'paused'}, {'goal_id': 'replacement'}):
            result, calls = self.exercise_check(apply=True, native=[(self.goal, self.root), ({**self.goal, **change}, self.root)])
            self.assertEqual(result['status'], 'state-changed-before-resume')
            self.assertEqual(calls, [])

    def test_pause_or_draft_after_typing_prevents_enter_and_does_not_restore_allowance(self):
        native = [(self.goal, self.root)] * 2 + [({**self.goal, 'status': 'paused'}, self.root)]
        result, calls = self.exercise_check(apply=True, native=native)
        self.assertEqual(result['status'], 'state-changed-before-enter-needs-review')
        self.assertEqual(len(calls), 1)
        self.assertTrue((self.root / 'recovery.json').exists())
        (self.root / 'recovery.json').unlink()
        result, calls = self.exercise_check(apply=True, screens=[EMPTY_SCREEN, EMPTY_SCREEN, ': human input\n'])
        self.assertEqual(result['status'], 'composer-changed-before-enter-needs-review')
        self.assertEqual(len(calls), 1)

    def test_only_new_tool_progress_resets_consecutive_attempts(self):
        ledger = {'attempts': [{'at': 800}], 'consecutive_attempts': 2}
        result, calls = self.exercise_check(apply=True, ledger=ledger, native=[({**self.goal, 'status': 'active'}, self.root)])
        self.assertEqual(result['status'], 'goal-active')
        self.assertEqual(json.loads((self.root / 'recovery.json').read_text())['consecutive_attempts'], 0)
        self.assertEqual(calls, [])
        ledger['attempts'] = [{'at': 900}]
        result, calls = self.exercise_check(apply=True, ledger=ledger)
        self.assertEqual(result['status'], 'recovery-exhausted-needs-review')
        self.assertEqual(calls, [])

    def test_healthy_checks_make_no_model_calls_and_never_inspect_or_touch_screen(self):
        with (patch.object(watch, 'read_native', return_value=({**self.goal, 'status': 'active'}, self.root)),
              patch.object(watch, 'rollout_evidence') as evidence,
              patch.object(watch.subprocess, 'run') as run):
            self.assertEqual(watch.check(self.config, self.root, True)['status'], 'goal-active')
            evidence.assert_not_called()
            run.assert_not_called()

    def test_full_filesystem_blocks_recovery_before_any_terminal_input(self):
        free = type('Free', (), {'f_bavail': 0, 'f_frsize': 4096})()
        with (patch.object(watch, 'read_native', return_value=(self.goal, self.root)),
              patch.object(watch, 'rollout_evidence', return_value=self.evidence),
              patch.object(watch.time, 'time', return_value=1100),
              patch.object(watch.os, 'statvfs', return_value=free),
              patch.object(watch.subprocess, 'run') as run):
            self.assertEqual(watch.check(self.config, self.root, True)['status'], 'disk-pressure-needs-review')
            run.assert_not_called()
        self.assertFalse((self.root / 'recovery.json').exists())

    def test_two_native_writers_or_changed_process_identity_cannot_be_selected(self):
        rollout = self.root / 'rollout-thread.jsonl'
        self.make_proc(456, 123, rollout)
        self.make_proc(457, 123, rollout)
        with self.assertRaises(RuntimeError):
            watch.native_identity(self.config, '123.fastpath', rollout, self.root / 'proc')

    def test_overlapping_cron_checks_are_locked_out(self):
        config = self.root / 'config.json'
        config.write_text(json.dumps({**self.config, 'state_dir': str(self.root)}))
        with (self.root / 'watch.lock').open('a') as lock:
            watch.fcntl.flock(lock, watch.fcntl.LOCK_EX | watch.fcntl.LOCK_NB)
            result = watch.subprocess.run(['/usr/bin/python3', str(Path(watch.__file__)),
                                           '--config', str(config), '--apply'],
                                          text=True, capture_output=True, timeout=5)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['status'], 'another-check-is-running')
        self.assertFalse((self.root / 'recovery.json').exists())


if __name__ == '__main__':
    unittest.main()
