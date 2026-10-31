"""Exercise GNU Screen input limits without a model request or a user session."""

import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest

import screen_sessions


@unittest.skipUnless(shutil.which('screen'), 'GNU Screen is required.')
class ScreenInputTests(unittest.TestCase):
    def test_long_resume_commands_and_unicode_arrive_without_silent_truncation(self):
        with tempfile.TemporaryDirectory(prefix='screen-input-test-') as directory:
            root = Path(directory)
            reader = root / 'reader.py'
            reader.write_text(
                'import pathlib,sys\n'
                'pathlib.Path(sys.argv[1]).touch()\n'
                'pathlib.Path(sys.argv[2]).write_text(sys.stdin.readline())\n')
            for index, payload in enumerate([
                    "codex resume exact-thread '" + 'Continue the saved verification. ' * 50 + "'",
                    'UTF-8 ' + '\U0001f642' * 300]):
                with self.subTest(index=index):
                    name = f'screen-input-test-{os.getpid()}-{index}'
                    ready, output = root / f'ready-{index}', root / f'output-{index}'
                    child = subprocess.Popen(
                        ['screen', '-U', '-DmS', name, sys.executable, str(reader), str(ready), str(output)],
                        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    try:
                        deadline = time.monotonic() + 5
                        while not ready.exists() and time.monotonic() < deadline:
                            time.sleep(.05)
                        self.assertTrue(ready.exists(), 'The isolated Screen reader did not start.')
                        screen_sessions.enter_command({'screen': name, 'window': '0'}, payload)
                        deadline = time.monotonic() + 5
                        while not output.exists() and time.monotonic() < deadline:
                            time.sleep(.05)
                        self.assertTrue(output.exists(), 'Screen dropped the submitted command.')
                        self.assertEqual(output.read_text(), payload + '\n')
                    finally:
                        subprocess.run(['screen', '-S', name, '-X', 'quit'], capture_output=True, timeout=5)
                        child.wait(timeout=5)


if __name__ == '__main__':
    unittest.main()
