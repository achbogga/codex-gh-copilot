"""Real Screen regression for mouse suppression without changing native input."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import screen_mouse_guard as mouse
import screen_sessions


def wait_for(predicate, seconds=5):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.05)
    return False


class MouseIdentityTests(unittest.TestCase):
    def test_reused_pid_or_changed_screen_or_window_is_rejected(self):
        target = {'pid': os.getpid(), 'start': '100', 'screen': '123.test', 'window': '0'}
        original = {**target, 'args': ['/runtime/codex'], 'foreground': True}
        for field, replacement in [('start', '101'), ('screen', '456.other'), ('window', '1')]:
            with self.subTest(field=field), patch.object(
                    screen_sessions, 'process', return_value={**original, field: replacement}):
                with self.assertRaises(RuntimeError), patch.object(mouse.os, 'open') as opened:
                    mouse.reset_mouse(target)
                opened.assert_not_called()

    def test_background_process_does_not_change_terminal(self):
        with patch.object(mouse, 'verify', return_value={'foreground': False}), \
                patch.object(mouse.os, 'open') as opened:
            self.assertFalse(mouse.reset_mouse({}))
            opened.assert_not_called()

    def test_guard_stops_when_original_process_exits(self):
        with patch.object(mouse, 'verify', side_effect=FileNotFoundError), \
                patch.object(screen_sessions, 'command') as command, \
                patch('builtins.print'):
            mouse.guard({})
            command.assert_not_called()


@unittest.skipUnless(shutil.which('screen') and Path('/proc').exists(), 'GNU Screen and procfs required.')
class NativeScreenMouseTests(unittest.TestCase):
    def test_live_reset_reenable_and_keystrokes_without_restart(self):
        with tempfile.TemporaryDirectory(prefix='screen-mouse-test-') as directory:
            root = Path(directory)
            executable = root / 'codex'
            executable.symlink_to(sys.executable)
            ready, incoming, enabled = (root / name for name in ('ready', 'incoming', 'enabled'))
            reader = root / 'reader.py'
            reader.write_text(
                'import json,os,pathlib,sys,tty\n'
                'root=pathlib.Path(sys.argv[1])\n'
                'tty.setraw(sys.stdin.fileno())\n'
                'def enable():\n'
                ' os.write(1,b"\\x1b[?1000h\\x1b[?1002h\\x1b[?1003h\\x1b[?1006h")\n'
                ' (root/"enabled").write_text("yes")\n'
                'enable()\n'
                '(root/"ready").write_text(str(os.getpid()))\n'
                'with (root/"incoming").open("ab",buffering=0) as output:\n'
                ' while True:\n'
                '  data=os.read(0,1024)\n'
                '  if not data: break\n'
                '  output.write(data)\n'
                '  if b"e" in data: enable()\n')
            name = f'screen-mouse-test-{os.getpid()}'
            child = subprocess.Popen(
                ['screen', '-U', '-DmS', name, str(executable), str(reader), str(root)],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            helper = None
            try:
                self.assertTrue(wait_for(ready.exists))
                target = screen_sessions.process(int(ready.read_text()))
                info = lambda: screen_sessions.command([
                    'screen', '-S', target['screen'], '-p', target['window'], '-Q', 'info'])
                self.assertIn(' mouse ', info())
                with self.assertRaises(RuntimeError):
                    mouse.reset_mouse({**target, 'start': str(int(target['start']) + 1)})
                self.assertIn(' mouse ', info(), 'A wrong identity must leave mouse modes alone.')
                helper = subprocess.Popen([
                    sys.executable, str(Path(mouse.__file__)), '--pid', str(target['pid']),
                    '--start', target['start'], '--screen', target['screen'],
                    '--window', target['window']], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                self.assertTrue(wait_for(lambda: ' mouse ' not in info()))
                self.assertTrue(screen_sessions.alive(target))
                enabled.unlink()
                screen_sessions.stuff(target, 'e')
                self.assertTrue(wait_for(enabled.exists), 'The simulated UI transition never ran.')
                self.assertTrue(wait_for(lambda: ' mouse ' not in info()), 'Re-enabled mouse capture survived.')
                payload = 'Typing stays intact: \U0001f642;123M'
                screen_sessions.stuff(target, payload)
                self.assertTrue(wait_for(lambda: incoming.read_bytes() == ('e' + payload).encode()))
                self.assertIsNone(helper.poll())
                self.assertTrue(screen_sessions.alive(target), 'The existing native process was replaced.')
                subprocess.run(['screen', '-S', name, '-X', 'quit'], capture_output=True, timeout=5)
                out, err = helper.communicate(timeout=5)
                self.assertEqual(helper.returncode, 0, err.decode())
                events = [json.loads(line)['event'] for line in out.splitlines()]
                self.assertGreaterEqual(events.count('mouse_reporting_disabled'), 2)
                self.assertEqual(events[-1], 'guard_stopped')
            finally:
                subprocess.run(['screen', '-S', name, '-X', 'quit'], capture_output=True, timeout=5)
                if helper and helper.poll() is None:
                    helper.terminate()
                    helper.communicate(timeout=5)
                child.wait(timeout=5)


@unittest.skipUnless(os.environ.get('COPILOT_PILOT_CODEX_BIN') and shutil.which('screen'),
                     'Set COPILOT_PILOT_CODEX_BIN for the installed-native TUI check.')
class NativeCodexInlineTests(unittest.TestCase):
    def test_inline_preference_disables_capture_in_the_installed_codex(self):
        # Never submit a model prompt. The test provider is loopback-only and
        # has no listener, so even an unintended inference cannot leave this host.
        with tempfile.TemporaryDirectory(prefix='codex-mouse-native-') as directory:
            root = Path(directory)
            for mode, captures in [('always', True), ('never', False)]:
                with self.subTest(mode=mode):
                    home = root / mode
                    home.mkdir(mode=0o700)
                    (home / 'config.toml').write_text(
                        f'[projects.{json.dumps(str(root))}]\ntrust_level="trusted"\n'
                        f'[tui]\nalternate_screen="{mode}"\nscreen_reader_detection_done=true\n')
                    name = f'codex-mouse-native-{os.getpid()}-{mode}'
                    env = {**os.environ, 'CODEX_HOME': str(home), 'TERM': 'xterm-256color'}
                    command = [os.environ['COPILOT_PILOT_CODEX_BIN'], '-C', str(root), '--yolo',
                               '-c', 'features.api_key_model_discovery=false',
                               '-c', 'model_provider="synthetic"', '-c', 'model="gpt-6.1-sol"',
                               '-c', 'model_providers.synthetic={name="Synthetic",'
                               'base_url="http://127.0.0.1:1/v1",wire_api="responses",'
                               'requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}']
                    subprocess.run(['screen', '-U', '-dmS', name, *command], env=env,
                                   check=True, capture_output=True, timeout=10)
                    target = {'screen': name, 'window': '0'}
                    try:
                        captures_seen = []
                        def ready():
                            captures_seen.append(screen_sessions.capture(target, root))
                            return screen_sessions.empty_composer(captures_seen[-1])
                        self.assertTrue(wait_for(ready, seconds=15),
                                        'Native TUI did not start: ' + captures_seen[-1][-2200:])
                        info = screen_sessions.command(['screen', '-S', name, '-p', '0', '-Q', 'info'])
                        self.assertEqual(' mouse ' in info, captures, info)
                    finally:
                        subprocess.run(['screen', '-S', name, '-X', 'quit'], capture_output=True, timeout=5)


if __name__ == '__main__':
    unittest.main()
