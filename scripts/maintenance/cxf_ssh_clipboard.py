#!/usr/bin/env python3
"""Run on your Mac: python3 cxf_ssh_clipboard.py -- [your usual ssh arguments].

Pass ordinary SSH terminal traffic through unchanged. Handle valid OSC 52
clipboard writes locally with /usr/bin/pbcopy for Terminal.app. Never read the
clipboard, log its contents, open a network listener, or change SSH options.
"""

import base64
import binascii
import fcntl
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import tty


class ClipboardFilter:
    prefix = b'\x1b]52;'
    max_bytes = 1024 * 1024

    def __init__(self, write_clipboard):
        self.write_clipboard = write_clipboard
        self.pending = b''

    def feed(self, data):
        self.pending += data
        output = bytearray()
        while self.pending:
            start = self.pending.find(self.prefix)
            if start < 0:
                # Retain only an actual partial OSC prefix, never ordinary
                # prompt characters that the user needs to see immediately.
                overlap = next((n for n in range(len(self.prefix) - 1, 0, -1)
                                if self.pending.endswith(self.prefix[:n])), 0)
                end = len(self.pending) - overlap
                output.extend(self.pending[:end])
                self.pending = self.pending[end:]
                break
            output.extend(self.pending[:start])
            self.pending = self.pending[start:]
            bell = self.pending.find(b'\x07', len(self.prefix))
            st = self.pending.find(b'\x1b\\', len(self.prefix))
            endings = [(p, size) for p, size in ((bell, 1), (st, 2)) if p >= 0]
            if not endings:
                if len(self.pending) > self.max_bytes * 4 // 3 + 1024:
                    output.extend(self.pending)
                    self.pending = b''
                break
            end, size = min(endings)
            sequence = self.pending[:end + size]
            body = self.pending[len(self.prefix):end]
            self.pending = self.pending[end + size:]
            copied = False
            try:
                selection, encoded = body.split(b';', 1)
                # Queries and non-clipboard selections are forwarded without
                # reading or modifying the local clipboard.
                if (selection in (b'', b'c') and encoded and encoded != b'?'
                        and len(encoded) <= (self.max_bytes + 2) // 3 * 4):
                    text = base64.b64decode(encoded, validate=True)
                    text.decode('utf-8')
                    if 0 < len(text) <= self.max_bytes:
                        self.write_clipboard(text)
                        copied = True
            except (ValueError, binascii.Error, UnicodeDecodeError, OSError, subprocess.SubprocessError):
                pass
            if not copied:
                output.extend(sequence)
        return bytes(output)

    def finish(self):
        remaining, self.pending = self.pending, b''
        return remaining


def pbcopy(text):
    try:
        subprocess.run(['/usr/bin/pbcopy'], input=text, stdout=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL, check=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        os.write(2, b'\r\n[cxf-ssh] Local clipboard write failed.\r\n')
        raise


def write_all(fd, data):
    while data:
        written = os.write(fd, data)
        if written <= 0:
            raise OSError('Terminal write failed.')
        data = data[written:]


def run_pty(command, write_clipboard=pbcopy, input_fd=0, output_fd=1):
    original = termios.tcgetattr(input_fd)
    master, slave = pty.openpty()
    previous_resize = signal.getsignal(signal.SIGWINCH)
    previous_term = signal.getsignal(signal.SIGTERM)
    child = None

    def resize(*_args):
        try:
            geometry = fcntl.ioctl(input_fd, termios.TIOCGWINSZ, b'\0' * 8)
            fcntl.ioctl(master, termios.TIOCSWINSZ, geometry)
        except OSError:
            pass

    def control_terminal():
        os.setsid()
        fcntl.ioctl(0, termios.TIOCSCTTY, 0)

    def terminate(signum, _frame):
        raise SystemExit(128 + signum)

    decoder = ClipboardFilter(write_clipboard)
    try:
        resize()
        signal.signal(signal.SIGWINCH, resize)
        signal.signal(signal.SIGTERM, terminate)
        child = subprocess.Popen(command, stdin=slave, stdout=slave, stderr=slave,
                                 preexec_fn=control_terminal, close_fds=True)
        os.close(slave)
        slave = None
        tty.setraw(input_fd)
        while True:
            readable, _, _ = select.select([master, input_fd], [], [])
            if master in readable:
                try:
                    data = os.read(master, 65536)
                except OSError:
                    break
                if not data:
                    break
                write_all(output_fd, decoder.feed(data))
            if input_fd in readable:
                data = os.read(input_fd, 65536)
                if not data:
                    break
                write_all(master, data)
        write_all(output_fd, decoder.finish())
        status = child.wait(timeout=5)
        return status if status >= 0 else 128 - status
    finally:
        try:
            termios.tcsetattr(input_fd, termios.TCSADRAIN, original)
        except termios.error:
            pass
        signal.signal(signal.SIGWINCH, previous_resize)
        signal.signal(signal.SIGTERM, previous_term)
        os.close(master)
        if slave is not None:
            os.close(slave)
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait(timeout=5)


def main():
    args = sys.argv[1:]
    if not args or args in (['-h'], ['--help']):
        print(__doc__)
        return 0 if args else 2
    if args[0] == '--':
        args = args[1:]
    if sys.platform != 'darwin' or not os.path.exists('/usr/bin/pbcopy'):
        raise SystemExit('Run this helper on your Mac, where the system clipboard lives.')
    if not args or not os.isatty(0) or not os.isatty(1):
        raise SystemExit('Run interactively with your usual SSH arguments after --.')
    return run_pty(['ssh', *args])


if __name__ == '__main__':
    raise SystemExit(main())
