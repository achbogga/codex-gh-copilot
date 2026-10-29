"""Opt-in real Codex + Screen test, using only a local synthetic model endpoint."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from contextlib import nullcontext
import importlib.util
import json
import os
from pathlib import Path
import shlex
import shutil
import sqlite3
import subprocess
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
import control_center

spec = importlib.util.spec_from_file_location('recovery_watch_native', Path(__file__).with_name('goal_recovery_watch.py'))
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)


@unittest.skipUnless(os.environ.get('COPILOT_PILOT_CODEX_BIN') and shutil.which('screen'),
                     'Set COPILOT_PILOT_CODEX_BIN to run the installed-native Screen regression.')
class NativeRecoveryTests(unittest.TestCase):
    def test_native_goal_recovers_in_the_same_screen_and_runs_a_real_shell_tool(self):
        self.run_native_recovery(compact=False)

    def test_native_connection_timeout_recovers_without_restarting_the_writer(self):
        self.run_native_recovery(compact=False, early_connection=True)

    @unittest.skipUnless(shutil.which('script'), 'The attached Screen check needs util-linux script.')
    def test_native_retry_keeps_an_attached_goal_running_without_the_watcher(self):
        self.run_native_recovery(compact=False, native_retry=True)

    def test_native_compaction_completes_before_the_same_goal_resumes_and_runs_tools(self):
        self.run_native_recovery(compact=True)

    def test_typed_native_overflow_with_a_replaced_goal_compacts_then_runs_tools(self):
        self.run_native_recovery(compact=True, overflow=True, follow_replaced=True)

    def test_control_center_pauses_compacts_and_resumes_the_exact_native_goal(self):
        self.run_native_recovery(compact=False, controls=True)

    def run_native_recovery(self, compact, overflow=False, follow_replaced=False, controls=False, early_connection=False, native_retry=False):
        with tempfile.TemporaryDirectory(prefix='codex-watch-native-') as directory:
            root = Path(directory)
            home = root / 'state'
            home.mkdir(mode=0o700)
            state = root / 'watch'
            state.mkdir(mode=0o700)
            (home / 'config.toml').write_text(f'[projects.{json.dumps(str(root))}]\ntrust_level="trusted"\n')
            marker = root / 'native-tool-result.txt'
            recovered = threading.Event()
            finish = threading.Event()
            request_count = []
            compaction_requests = []

            class Handler(BaseHTTPRequestHandler):
                def log_message(self, *_args):
                    pass

                def do_POST(self):
                    body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                    request_count.append(recovered.is_set())
                    if early_connection and not recovered.is_set():
                        self.send_response(502)
                        self.send_header('Content-Type', 'application/json')
                        self.send_header('Connection', 'close')
                        self.end_headers()
                        self.wfile.write(json.dumps({'error': {
                            'message': 'Connecting to Copilot failed before a response (UND_ERR_CONNECT_TIMEOUT).',
                            'type': 'copilot_pilot_error'}}).encode())
                        self.wfile.flush()
                        return
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/event-stream')
                    self.send_header('Connection', 'close')
                    self.end_headers()
                    if not recovered.is_set():
                        events = [{'type': 'response.failed', 'response': {'error': {
                            'code': 'context_length_exceeded' if overflow else 'stream_interrupted',
                            'message': 'Copilot stream ended before completion (UND_ERR_SOCKET).'}}}]
                        if native_retry:
                            recovered.set()
                    elif (compact or controls) and not compaction_requests and 'CONTEXT CHECKPOINT COMPACTION' in json.dumps(body):
                        compaction_requests.append(True)
                        events = [{'type': 'response.output_item.done', 'item': {
                            'type': 'message', 'id': 'summary', 'role': 'assistant',
                            'content': [{'type': 'output_text', 'text': 'Continue the synthetic local recovery goal. No tools have run yet.'}]}},
                            {'type': 'response.completed', 'response': {'id': 'compacted', 'usage': {
                                'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
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
                        finish.wait(timeout=10) if controls or native_retry else time.sleep(2)
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
                       'requires_openai_auth=false,request_max_retries=0,stream_max_retries='
                       + ('1}' if native_retry else '0}')]
            attachment = None
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
                if native_retry:
                    # script supplies a controlling PTY without detaching or
                    # sending input to any real user's Screen.
                    attachment = subprocess.Popen(
                        ['script', '-q', '-e', '-c', shlex.join(['screen', '-r', session]), '/dev/null'],
                        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        listing = subprocess.check_output(['screen', '-ls'], text=True)
                        if any(session in line and '(Attached)' in line for line in listing.splitlines()):
                            break
                        time.sleep(.1)
                    self.assertTrue(any(session in line and '(Attached)' in line for line in listing.splitlines()), listing)
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
                        goal, rollout = watch.read_native(config)
                        if native_retry and marker.exists():
                            break
                        if goal and goal['status'] == 'blocked':
                            # The goal SQLite commit can precede the rollout's
                            # failed-completion record. Recovery correctly waits
                            # for that durable evidence; the fixture must too.
                            completion = watch.rollout_evidence(rollout).get('completion') or {}
                            if completion.get('failed'):
                                break
                    except sqlite3.OperationalError:
                        pass
                    time.sleep(.2)
                self.assertIsNotNone(goal)
                if native_retry:
                    self.assertEqual(goal['status'], 'active', watch.capture_screen(session, 0, state))
                    self.assertTrue(marker.exists(), 'Native retry did not execute the continuation tool.')
                    self.assertEqual(marker.read_text(), 'WATCHDOG_NATIVE_OK')
                    self.assertEqual(goal['thread_id'], config['thread_id'])
                    self.assertEqual(request_count.count(False), 1)
                    self.assertTrue(any(request_count))
                    self.assertFalse((state / 'recovery.json').exists(), 'Native retry must not need the watcher.')
                    listing = subprocess.check_output(['screen', '-ls'], text=True)
                    self.assertTrue(any(session in line and '(Attached)' in line for line in listing.splitlines()), listing)
                    return
                self.assertEqual(goal['status'], 'blocked')
                config['goal_id'] = 'previous-goal' if follow_replaced else goal['goal_id']
                config['follow_current_goal'] = follow_replaced
                config['compact_after_transport_failure'] = compact
                recovered.set()
                # Failure-age grace is advanced only for this synthetic check;
                # all identity, native state, input and acceptance checks are real.
                original_gate = watch.blocked_reason
                with (patch.object(watch, 'blocked_reason', side_effect=lambda c, g, e, l, n: original_gate(c, g, e, l, n + 61)),
                      nullcontext() if overflow else patch.object(watch, 'needs_compaction', return_value=compact)):
                    result = watch.check(config, state, apply=True)
                if compact:
                    self.assertEqual(result['status'], 'compaction-requested', result)
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        _, rollout = watch.read_native(config)
                        evidence = watch.rollout_evidence(rollout)
                        if evidence['compacted_at'] and evidence['completion'] and evidence['completion']['at'] >= evidence['compacted_at']:
                            break
                        time.sleep(.1)
                    self.assertEqual(len(compaction_requests), 1)
                    self.assertFalse(marker.exists(), 'The goal must not execute tools while it is still compacting.')
                    self.assertIn('pending_compaction', json.loads((state / 'recovery.json').read_text()))
                    result = watch.check(config, state, apply=True)
                self.assertEqual(result['status'], 'resume-accepted', result)
                deadline = time.monotonic() + 15
                while not marker.exists() and time.monotonic() < deadline:
                    time.sleep(.1)
                self.assertTrue(marker.exists(), 'Resumed native goal did not execute its shell tool.')
                self.assertEqual(marker.read_text(), 'WATCHDOG_NATIVE_OK')
                after, rollout = watch.read_native(config)
                self.assertEqual(after['thread_id'], config['thread_id'])
                self.assertEqual(after['goal_id'], goal['goal_id'])
                self.assertTrue(any(request_count))
                self.assertEqual(request_count.count(False), 1,
                                 'A failed inference must stop before the watcher controls recovery.')
                identity = watch.native_identity(config, session, rollout)
                self.assertEqual(identity[0], result['native_pid'])
                if controls:
                    target = next(t for t in control_center.screens.inventory() if t['screen'] == session)
                    row = {'screen': session, 'window': '0', 'pid': target['pid'], 'thread_id': config['thread_id'],
                           'verified': True, 'target': target}
                    self.assertIn('/goal pause submitted', control_center.act(row, 'pause', state, root / 'unused.json'))
                    deadline = time.monotonic() + 10
                    while time.monotonic() < deadline:
                        paused, _ = watch.read_native(config)
                        if paused['status'] == 'paused' and not control_center.screens.busy(watch.capture_screen(session, 0, state)):
                            break
                        time.sleep(.1)
                    self.assertEqual(paused['status'], 'paused')
                    self.assertIn('/compact submitted', control_center.act(row, 'compact', state, root / 'unused.json'))
                    deadline = time.monotonic() + 15
                    while time.monotonic() < deadline:
                        _, rollout = watch.read_native(config)
                        evidence = watch.rollout_evidence(rollout)
                        if evidence['compacted_at'] and evidence['completion'] and evidence['completion']['at'] >= evidence['compacted_at']:
                            break
                        time.sleep(.1)
                    self.assertEqual(len(compaction_requests), 1)
                    self.assertEqual(watch.read_native(config)[0]['status'], 'paused')
                    self.assertIn('/goal resume submitted', control_center.act(row, 'resume', state, root / 'unused.json'))
                    self.assertEqual(watch.wait_for_active(config), 'resume-accepted')
                    self.assertEqual(watch.read_native(config)[0]['goal_id'], goal['goal_id'])
            finally:
                finish.set()
                subprocess.run(['screen', '-S', name, '-X', 'quit'], check=False,
                               capture_output=True, timeout=10)
                if attachment:
                    attachment.stdin.close()
                    try:
                        attachment.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        attachment.terminate()
                        attachment.wait(timeout=5)
                server.shutdown()
                server.server_close()
                time.sleep(.5)


if __name__ == '__main__':
    unittest.main()
