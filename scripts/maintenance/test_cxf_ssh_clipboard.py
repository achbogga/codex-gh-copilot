"""Verify the optional Mac-side clipboard adapter without accessing a clipboard."""

import base64
import os
import pty
import select
import signal
import sys
import termios
import unittest

from cxf_ssh_clipboard import ClipboardFilter, run_pty


def osc(text, ending=b'\x07'):
    return b'\x1b]52;c;' + base64.b64encode(text) + ending


class ClipboardFilterTests(unittest.TestCase):
    def test_copy_survives_every_read_boundary_and_preserves_terminal_bytes(self):
        text = 'Copied text \U0001f642\nsecond line'.encode()
        for ending in (b'\x07', b'\x1b\\'):
            data = b'\x1b[31mbefore\x1b[0m' + osc(text, ending) + b'after\r\n'
            expected = b'\x1b[31mbefore\x1b[0mafter\r\n'
            for split in range(len(data) + 1):
                with self.subTest(ending=ending, split=split):
                    copies = []
                    decoder = ClipboardFilter(copies.append)
                    output = decoder.feed(data[:split]) + decoder.feed(data[split:]) + decoder.finish()
                    self.assertEqual(output, expected)
                    self.assertEqual(copies, [text])

    def test_plain_prompts_are_forwarded_immediately(self):
        decoder = ClipboardFilter(self.fail)
        for prompt in (b'Password: ', b'Enter passphrase: ', b'\x1b[2J\x1b[Hshell$ '):
            self.assertEqual(decoder.feed(prompt), prompt)
        self.assertEqual(decoder.finish(), b'')

    def test_invalid_queries_other_selections_and_empty_requests_never_change_clipboard(self):
        cases = [b'\x1b]52;c;?\x07', b'\x1b]52;c;\x07', b'\x1b]52;p;YWJj\x07',
                 b'\x1b]52;c;not-base64\x07', osc(b'\xff'), b'\x1b]52;missing-separator\x07',
                 b'\x1b]52;c;unfinished']
        for data in cases:
            with self.subTest(data=data):
                copies = []
                decoder = ClipboardFilter(copies.append)
                self.assertEqual(decoder.feed(data) + decoder.finish(), data)
                self.assertEqual(copies, [])

    def test_oversized_or_failed_writes_preserve_original_terminal_data(self):
        for payload in (b'abc', b'abcd'):
            copies = []
            decoder = ClipboardFilter(copies.append)
            decoder.max_bytes = 3
            data = osc(payload)
            result = decoder.feed(data) + decoder.finish()
            self.assertEqual(copies, [payload] if len(payload) <= 3 else [])
            self.assertEqual(result, b'' if copies else data)
        def fail(_text):
            raise OSError('Synthetic unavailable clipboard.')
        decoder = ClipboardFilter(fail)
        data = osc(b'abc')
        self.assertEqual(decoder.feed(data), data)

    def test_multiple_clipboard_writes_and_one_byte_reads(self):
        data = b'a' + osc(b'first') + b'b' + osc(b'second') + b'c'
        copies = []
        decoder = ClipboardFilter(copies.append)
        output = b''.join(decoder.feed(bytes([byte])) for byte in data) + decoder.finish()
        self.assertEqual(output, b'abc')
        self.assertEqual(copies, [b'first', b'second'])


class ClipboardPtyTests(unittest.TestCase):
    def test_pty_keeps_output_exit_status_and_terminal_settings(self):
        master, slave = pty.openpty()
        before = termios.tcgetattr(slave)
        signals = {sig: signal.getsignal(sig) for sig in (signal.SIGWINCH, signal.SIGTERM)}
        copies = []
        prefix = b'\x1b[31mcolored\x1b[0m-before-'
        suffix = b'-after'
        payload = prefix + osc('clipboard \U0001f642'.encode()) + suffix
        command = [sys.executable, '-c', 'import os;os.write(1,' + repr(payload) + ');raise SystemExit(17)']
        try:
            status = run_pty(command, copies.append, input_fd=slave, output_fd=slave)
            self.assertEqual(status, 17)
            self.assertEqual(copies, ['clipboard \U0001f642'.encode()])
            self.assertEqual(termios.tcgetattr(slave), before)
            self.assertEqual({sig: signal.getsignal(sig) for sig in signals}, signals)
            output = b''
            while select.select([master], [], [], .1)[0]:
                output += os.read(master, 65536)
            self.assertEqual(output, prefix + suffix)
        finally:
            os.close(master)
            os.close(slave)


if __name__ == '__main__':
    unittest.main()
