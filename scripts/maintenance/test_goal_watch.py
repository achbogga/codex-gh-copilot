import importlib.util
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('goal_watch', Path(__file__).with_name('goal_watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


class WatchTests(unittest.TestCase):
    def test_human_pauses_completed_goals_and_budget_limits_are_respected(self):
        for status in ['paused', 'complete', 'completed', 'usage_limited']:
            self.assertFalse(watch.should_audit({'status': status}))
        self.assertFalse(watch.should_audit(None))
        self.assertTrue(watch.should_audit({'status': 'active'}))
        self.assertTrue(watch.should_audit({'status': 'blocked'}))

    def test_goal_read_does_not_create_or_update_native_state(self):
        with tempfile.TemporaryDirectory() as path:
            root = Path(path)
            db = root / 'goals_1.sqlite'
            with sqlite3.connect(db) as c:
                c.execute('CREATE TABLE thread_goals (thread_id TEXT, goal_id TEXT, status TEXT, tokens_used INTEGER, time_used_seconds INTEGER, updated_at_ms INTEGER)')
                c.execute("INSERT INTO thread_goals VALUES ('watched', 'the-goal', 'active', 42, 12, 123)")
            original = db.read_bytes()
            self.assertEqual(watch.read_goal(root, 'watched')['tokens_used'], 42)
            self.assertIsNone(watch.read_goal(root, 'different'))
            self.assertEqual(db.read_bytes(), original)

    def test_ambiguous_screen_names_fail_without_choosing_or_signalling_a_process(self):
        result = type('Result', (), {'stdout': '  123.lance_migration (Detached)\n  456.lance_migration (Detached)\n'})()
        with patch.object(watch.subprocess, 'run', return_value=result) as run:
            with self.assertRaises(RuntimeError):
                watch.screen_session('lance_migration')
            self.assertEqual(run.call_count, 1)
        result.stdout = '  123.lance_migration (Detached)\n'
        with patch.object(watch.subprocess, 'run', return_value=result):
            self.assertEqual(watch.screen_session('lance_migration'), '123.lance_migration')

    def test_audit_timeout_terminates_only_its_isolated_process_group(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            launcher = root / 'slow-audit'
            launcher.write_text('#!/usr/bin/python3\nimport time\ntime.sleep(60)\n')
            launcher.chmod(0o700)
            config = {'launcher': str(launcher), 'harness_repo': str(root),
                      'thread_id': 'watched', 'screen_name': 'watched',
                      'project': str(root), 'codex_home': str(root),
                      'cleanup_command': 'safe-cleanup'}
            unrelated = subprocess.Popen(['/usr/bin/sleep', '30'], start_new_session=True)
            try:
                self.assertEqual(watch.run_audit(config, root, root / 'report.json', 0.1), 124)
                self.assertIsNone(unrelated.poll(), 'An unrelated session must remain running.')
            finally:
                unrelated.terminate()
                unrelated.wait()


if __name__ == '__main__':
    unittest.main()
