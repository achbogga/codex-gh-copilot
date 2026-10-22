"""Opt-in real Codex + Screen test, using only a local synthetic model endpoint."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('recovery_watch_native', Path(__file__).with_name('goal_recovery_watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


@unittest.skipUnless(os.environ.get('COPILOT_PILOT_CODEX_BIN') and shutil.which('screen'),
                     'Set COPILOT_PILOT_CODEX_BIN to run the installed-native Screen regression.')
class NativeRecoveryTests(unittest.TestCase):
    def test_native_goal_recovers_in_the_same_screen_and_runs_a_real_shell_tool(self):
        with tempfile.TemporaryDirectory(prefix='codex-watch-native-') as directory:
            root = Path(directory)
            home = root / 'state'
            home.mkdir(mode=0o700)
            state = root / 'watch'
            state.mkdir(mode=0o700)
            (home / 'config.toml').write_text(f'[projects.{json.dumps(str(root))}]\ntrust_level="trusted"\n')
            marker = root / 'native-tool-result.txt'
            recovered = threading.Event()
            request_count = []

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_POST(self):
                    json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    request_count.append(recovered.is_set())
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    if not recovered.is_set():
                        events = [{'type': 'response.failed', 'response': {'error': {
                            'code': 'stream_interrupted',
                            'message': 'Copilot stream ended before completion (UND_ERR_SOCKET).'}}}]
                    elif not marker.exists():
                        events = [{'type': 'response.output_item.done', 'item': {
                            'type': 'custom_tool_call', 'call_id': 'native-watch-shell',
                            'name': 'exec', 'namespace': 'functions',
                            'input': 'text(await tools.exec_command({cmd: ' + json.dumps(
                                "printf WATCHDOG_NATIVE_OK > '" + str(marker) + "'") + '}));'}},
                            {'type': 'response.completed', 'response': {'id': 'done', 'usage': {
                                'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
                    else:
                        # Hold this synthetic turn until the test closes its own
                        # Screen. No remote model or goal continuation is needed.
                        time.sleep(2)
                        events = [{'type': 'response.failed', 'response': {'error': {
                            'code': 'invalid_prompt', 'message': 'Synthetic test finished.'}}}]
                    try:
                        self.wfile.write(''.join('data: ' + json.dumps(event) + '\n\n'
                                                 for event in events).encode())
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError):
                        pass

            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            threading.Thread(target=server.serve_forever, daemon=True).start()
            name = f'watch-native-{os.getpid()}'
            env = {**os.environ, 'CODEX_HOME': str(home), 'TERM': 'xterm-256color'}
            command = [os.environ['COPILOT_PILOT_CODEX_BIN'], '-C', str(root), '--yolo',
                       '-c', 'features.goals=true', '-c', 'features.api_key_model_discovery=false',
                       '-c', 'features.multi_agent=false', '-c', 'model_provider="synthetic"',
                       '-c', 'model="gpt-6.1-sol"', '-c', 'model_providers.synthetic={name="Synthetic",'
                       f'base_url="http://127.0.0.1:{server.server_port}/v1",wire_api="responses",'
                       'requires_openai_auth=false,stream_max_retries=0}']
            try:
                subprocess.run(['screen', '-U', '-dmS', name, *command],
                               env=env, check=True, timeout=10)
                session = watch.detached_screen(name)
                subprocess.run(['screen', '-S', session, '-p', '0', '-X', 'width', '-w', '160', '45'],
                               check=True, timeout=10)
                deadline = time.monotonic() + 20
                screen = ''
                while time.monotonic() < deadline:
                    screen = watch.capture_screen(session, 0, state)
                    if 'Ask Codex to do anything' in screen:
                        break
                    time.sleep(.2)
                self.assertIn('Ask Codex to do anything', screen, screen)
                subprocess.run(['screen', '-S', session, '-p', '0', '-X', 'stuff',
                                '/goal synthetic local transport recovery check'], check=True)
                time.sleep(.4)
                subprocess.run(['screen', '-S', session, '-p', '0', '-X', 'stuff', '\r'], check=True)
                deadline = time.monotonic() + 30
                config = None
                while time.monotonic() < deadline:
                    try:
                        with sqlite3.connect((home / 'state_5.sqlite').as_uri() + '?mode=ro', uri=True) as c:
                            row = c.execute('SELECT id FROM threads LIMIT 1').fetchone()
                        if row:
                            config = {'codex_home': str(home), 'thread_id': row[0], 'goal_id': '',
                                      'screen_name': name, 'project': str(root), 'min_free_gib': 0}
                            break
                    except sqlite3.OperationalError:
                        pass
                    time.sleep(.1)
                self.assertIsNotNone(config, watch.capture_screen(session, 0, state))
                deadline = time.monotonic() + 30
                goal = None
                while time.monotonic() < deadline:
                    try:
                        goal, _ = watch.read_native(config)
                        if goal and goal['status'] == 'blocked':
                            break
                    except sqlite3.OperationalError:
                        pass
                    time.sleep(.2)
                self.assertIsNotNone(goal)
                self.assertEqual(goal['status'], 'blocked')
                config['goal_id'] = goal['goal_id']
                recovered.set()
                # Failure-age grace is advanced only for this synthetic check;
                # all identity, native state, input and acceptance checks are real.
                with patch.object(watch.time, 'time', return_value=time.time() + 61):
                    result = watch.check(config, state, apply=True)
                self.assertEqual(result['status'], 'resume-accepted', result)
                deadline = time.monotonic() + 15
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertTrue(marker.exists(), 'Resumed native goal did not execute its shell tool.')
                self.assertEqual(marker.read_text(), 'WATCHDOG_NATIVE_OK')
                after, rollout = watch.read_native(config)
                self.assertEqual(after['thread_id'], config['thread_id'])
                self.assertEqual(after['goal_id'], config['goal_id'])
                self.assertTrue(any(request_count))
                identity = watch.native_identity(config, session, rollout)
                self.assertEqual(identity[0], result['native_pid'])
            finally:
                subprocess.run(['screen', '-S', name, '-X', 'quit'], check=False,
                               capture_output=True, timeout=10)
                server.shutdown()
                server.server_close()
                time.sleep(.5)


if __name__ == '__main__':
    unittest.main()
