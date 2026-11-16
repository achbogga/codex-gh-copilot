"""Opt-in installed Codex test: older Screen history remains selectable/copyable."""

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import time
import unittest

import screen_sessions as sessions


def wait_for(predicate, seconds=15):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.1)
    return False


@unittest.skipUnless(os.environ.get('COPILOT_PILOT_CODEX_BIN') and shutil.which('screen'),
                     'Set COPILOT_PILOT_CODEX_BIN for the installed-native scrollback check.')
class NativeScrollbackTests(unittest.TestCase):
    def test_old_page_can_be_scrolled_to_copied_and_pasted_without_submitting(self):
        requests = []
        text = '\n\n'.join(f'SCROLLBACK_{i:04d} retained synthetic history row.' for i in range(180))

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                requests.append({'path': self.path, 'generate': body.get('generate'),
                                 'input_count': len(body.get('input', []))})
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.send_header('Connection', 'close')
                self.end_headers()
                events = [
                    {'type': 'response.output_item.done', 'item': {
                        'type': 'message', 'id': 'synthetic-history', 'role': 'assistant',
                        'content': [{'type': 'output_text', 'text': text}]}},
                    {'type': 'response.completed', 'response': {
                        'id': 'synthetic-response', 'usage': {
                            'input_tokens': 1, 'output_tokens': 1, 'total_tokens': 2}}}]
                for event in events:
                    self.wfile.write(('data: ' + json.dumps(event) + '\n\n').encode())
                self.wfile.flush()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        server.daemon_threads = True
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix='native-scrollback-') as directory:
                root = Path(directory)
                home = root / 'state'
                home.mkdir(mode=0o700)
                (home / 'config.toml').write_text(
                    f'[projects.{json.dumps(str(root))}]\ntrust_level="trusted"\n'
                    '[tui]\nalternate_screen="never"\ntheme="github"\nscreen_reader_detection_done=true\n')
                screenrc = root / 'screenrc'
                screenrc.write_text('defscrollback 10000\n')
                name = f'native-scrollback-{os.getpid()}'
                target = {'screen': name, 'window': '0'}
                command = [os.environ['COPILOT_PILOT_CODEX_BIN'], '-C', str(root), '--yolo',
                           '-c', 'features.api_key_model_discovery=false',
                           '-c', 'model_provider="synthetic"', '-c', 'model="gpt-6.1-sol"',
                           '-c', 'model_providers.synthetic={name="Synthetic",'
                           f'base_url="http://127.0.0.1:{server.server_port}/v1",wire_api="responses",'
                           'requires_openai_auth=false,request_max_retries=0,stream_max_retries=0}']
                env = {**os.environ, 'CODEX_HOME': str(home), 'TERM': 'xterm-256color'}
                subprocess.run(['screen', '-U', '-c', str(screenrc), '-dmS', name, *command],
                               env=env, check=True, capture_output=True, timeout=10)
                try:
                    self.assertTrue(wait_for(lambda: sessions.empty_composer(sessions.capture(target, root))))
                    sessions.enter_command(target, 'Show the synthetic history.')
                    self.assertTrue(wait_for(lambda: requests and sessions.empty_composer(
                        sessions.capture(target, root)) and not sessions.busy(sessions.capture(target, root))))
                    history = root / 'history.txt'
                    sessions.command(['screen', '-S', name, '-p', '0', '-X', 'hardcopy', '-h', str(history)])
                    self.assertTrue(wait_for(lambda: history.exists() and 'SCROLLBACK_0179' in history.read_text(errors='replace')))
                    self.assertIn('SCROLLBACK_0000', history.read_text(errors='replace'))
                    self.assertNotIn('SCROLLBACK_0000', sessions.capture(target, root))
                    time.sleep(.3)
                    baseline = len(requests)
                    # Disk export hydrates the complete native history instead
                    # of relying on Screen's finite in-memory buffer.
                    export = root / 'complete-history.md'
                    sessions.enter_command(target, '/export ' + str(export))
                    self.assertTrue(wait_for(lambda: export.exists() and export.stat().st_size > 0))
                    markdown = export.read_text()
                    self.assertIn('SCROLLBACK_0000', markdown)
                    self.assertIn('SCROLLBACK_0179', markdown)
                    self.assertEqual(len(requests), baseline, 'Export submitted a model prompt.')
                    # Select a line from the first page, far above the current viewport.
                    with sessions.screen_attachment(target) as (keyboard, drain):
                        os.write(keyboard, b'\x01[g/SCROLLBACK_0000\r0 $ ')
                        drain(.3)
                    clipboard = root / 'screen-clipboard.txt'
                    sessions.command(['screen', '-S', name, '-X', 'writebuf', str(clipboard)])
                    self.assertTrue(wait_for(clipboard.exists))
                    self.assertIn('SCROLLBACK_0000', clipboard.read_text(errors='replace'))
                    sessions.command(['screen', '-S', name, '-p', '0', '-X', 'paste', '.'])
                    self.assertTrue(wait_for(lambda: 'SCROLLBACK_0000' in '\n'.join(
                        sessions.capture(target, root).rstrip().splitlines()[-8:])))
                    time.sleep(.3)
                    self.assertEqual(len(requests), baseline, f'Copy/paste submitted another model request: {requests}')
                finally:
                    subprocess.run(['screen', '-S', name, '-X', 'quit'], capture_output=True, timeout=5)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)


if __name__ == '__main__':
    unittest.main()
