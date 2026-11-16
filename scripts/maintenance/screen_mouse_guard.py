#!/usr/bin/python3
"""Keep mouse reporting off for one identified, already-running Codex Screen.

Temporary mitigation for fragmented terminal mouse reports. Writes terminal
output only; never reads or filters keystrokes, submits prompts, or restarts a
thread. Exits when the original process or Screen disappears. Use inline TUI
mode for subsequent launches rather than keeping a permanent polling service.
"""

import argparse
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

import screen_sessions


RESET_MOUSE = b''.join(f'\x1b[?{mode}l'.encode() for mode in
                       (1000, 1002, 1003, 1005, 1006, 1015, 1016))


def verify(target):
    root = Path('/proc') / str(target['pid'])
    if root.stat().st_uid != os.getuid():
        raise RuntimeError('The target belongs to another user.')
    current = screen_sessions.process(target['pid'])
    if any(current[key] != target[key] for key in ('pid', 'start', 'screen', 'window')):
        raise RuntimeError('The original Codex process identity changed.')
    args = current['args']
    if (not args or Path(args[0]).name != 'codex'
            or any(arg in ('exec', 'app-server', 'mcp-server') for arg in args)):
        raise RuntimeError('The target is not an interactive native Codex process.')
    return current


def reset_mouse(target):
    """Write mode resets to the verified TTY's output side, never its input."""
    current = verify(target)
    if not current['foreground']:
        return False
    descriptors = Path('/proc') / str(target['pid']) / 'fd'
    tty = os.readlink(descriptors / '1')
    if not re.fullmatch(r'/dev/pts/[0-9]+', tty):
        raise RuntimeError('Native stdout is not a PTY.')
    expected = os.stat(descriptors / '1')
    incoming = os.stat(descriptors / '0')
    if (not stat.S_ISCHR(expected.st_mode)
            or (incoming.st_dev, incoming.st_ino) != (expected.st_dev, expected.st_ino)):
        raise RuntimeError('Native stdin and stdout do not identify the same PTY.')
    fd = os.open(tty, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        actual = os.fstat(fd)
        if (actual.st_dev, actual.st_ino) != (expected.st_dev, expected.st_ino):
            raise RuntimeError('The native PTY changed before opening.')
        if not verify(target)['foreground']:
            return False
        pending = RESET_MOUSE
        while pending:
            written = os.write(fd, pending)
            if written <= 0:
                raise RuntimeError('Terminal mode reset was not delivered.')
            pending = pending[written:]
        return True
    finally:
        os.close(fd)


def guard(target, interval=.5):
    resets = 0
    while True:
        try:
            verify(target)
            info = screen_sessions.command([
                'screen', '-S', target['screen'], '-p', target['window'], '-Q', 'info'])
            if re.search(r'\bmouse\b', info) and reset_mouse(target):
                resets += 1
                print(json.dumps({'event': 'mouse_reporting_disabled', 'resets': resets}), flush=True)
        except (OSError, RuntimeError, IndexError, subprocess.SubprocessError):
            # A lost identity or control channel cannot authorize another write.
            print(json.dumps({'event': 'guard_stopped', 'resets': resets}), flush=True)
            return
        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pid', type=int, required=True)
    parser.add_argument('--start', required=True)
    parser.add_argument('--screen', required=True)
    parser.add_argument('--window', default='0')
    options = parser.parse_args()
    if options.pid <= 0 or not options.start.isdigit():
        parser.error('An exact native PID and /proc start identity are required.')
    target = vars(options)
    verify(target)
    guard(target)


if __name__ == '__main__':
    main()
