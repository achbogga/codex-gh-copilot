#!/usr/bin/python3
"""Inventory and reload exact native threads in existing GNU Screen shells."""

import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import shlex
import sqlite3
import subprocess
import time


def command(args):
    return subprocess.check_output(args, text=True, stderr=subprocess.PIPE, timeout=15)


def process(pid):
    root = Path('/proc') / str(pid)
    fields = (root / 'stat').read_text().rsplit(')', 1)[1].split()
    args = [os.fsdecode(a) for a in (root / 'cmdline').read_bytes().split(b'\0') if a]
    environment = dict(entry.split(b'=', 1) for entry in (root / 'environ').read_bytes().split(b'\0') if b'=' in entry)
    return {'pid': int(pid), 'parent': int(fields[1]), 'start': fields[19], 'args': args,
            'screen': os.fsdecode(environment.get(b'STY', b'')),
            'window': os.fsdecode(environment.get(b'WINDOW', b'0')),
            'home': os.fsdecode(environment.get(b'CODEX_HOME', b'')),
            'foreground': fields[2] == fields[5]}


def alive(identity):
    try:
        return process(identity['pid'])['start'] == identity['start']
    except (OSError, IndexError):
        return False


def root_thread(home, pid, controller=None):
    database = home / 'state_5.sqlite'
    if not database.is_file():
        return None
    paths = set()
    for descriptor in (Path('/proc') / str(pid) / 'fd').iterdir():
        try:
            target = os.readlink(descriptor)
        except FileNotFoundError:
            continue
        if 'rollout-' in target:
            paths.add(target)
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        rows = [dict(row) for row in connection.execute(
            'SELECT id,source,cwd,model,reasoning_effort,rollout_path FROM threads '
            'WHERE source=\'cli\' AND rollout_path IN (' + ','.join('?' for _ in paths) + ')', tuple(paths))] if paths else []
        if not rows and controller:
            row = connection.execute('SELECT id,source,cwd,model,reasoning_effort,rollout_path FROM threads WHERE id=? AND source=\'cli\'',
                                     (controller,)).fetchone()
            rows = [dict(row)] if row else []
    if len(rows) > 1:
        raise RuntimeError('Multiple root threads are open; refusing to guess.')
    return rows[0] if rows else None


def goal(home, thread):
    database = home / 'goals_1.sqlite'
    if not database.exists():
        return None
    with sqlite3.connect(database.as_uri() + '?mode=ro', uri=True, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute('SELECT thread_id,goal_id,status,token_budget,tokens_used,updated_at_ms '
                                 'FROM thread_goals WHERE thread_id=?', (thread,)).fetchone()
    return dict(row) if row else None


def inventory(controller=None):
    screens = set(re.findall(r'^\s*(\d+\.[^\s]+)\s', command(['screen', '-ls']), re.M))
    targets = []
    defaults = []
    for root in Path('/proc').iterdir():
        if not root.name.isdigit():
            continue
        try:
            if root.stat().st_uid != os.getuid():
                continue
            info = process(int(root.name))
            args = info['args']
            if not args or Path(args[0]).name != 'codex' or any(a in args for a in ('exec', 'app-server', 'mcp-server')):
                continue
            if info['screen'] not in screens:
                continue
            home = Path(info['home']) if info['home'] else Path.home() / '.codex'
            backend = 'native'
            parent = info['parent']
            launch_process = None
            screen_pid = int(info['screen'].split('.')[0])
            for _ in range(20):
                if parent in (0, 1, screen_pid):
                    break
                ancestor = process(parent)
                if any(a.endswith('/host-run.mjs') for a in ancestor['args']):
                    backend = 'copilot'
                    launch_process = {'pid': ancestor['pid'], 'start': ancestor['start']}
                elif launch_process is None and ancestor['args'] and Path(ancestor['args'][0]).name == 'node':
                    launch_process = {'pid': ancestor['pid'], 'start': ancestor['start']}
                parent = ancestor['parent']
            if parent != screen_pid:
                continue
            thread = root_thread(home, info['pid'])
            entry = {k: info[k] for k in ('pid', 'start', 'screen', 'window')}
            entry.update({'home': str(home), 'backend': backend, 'launcher_process': launch_process,
                          'thread': thread, 'controller': bool(thread and thread['id'] == controller)})
            if thread:
                entry['goal'] = goal(home, thread['id'])
                targets.append(entry)
            elif backend == 'native' and home == Path.home() / '.codex':
                defaults.append(entry)
        except (OSError, sqlite3.Error, IndexError):
            continue
    # The controlling TUI can close its rollout descriptor while a tool runs.
    # Only its explicitly supplied thread, in one unambiguous default-home TUI,
    # may use this fallback. Never substitute --last or another newest thread.
    if controller and len(defaults) == 1 and not any(t['controller'] for t in targets):
        entry = defaults[0]
        thread = root_thread(Path(entry['home']), entry['pid'], controller)
        if thread:
            entry.update({'thread': thread, 'goal': goal(Path(entry['home']), thread['id']), 'controller': True})
            targets.append(entry)
    return targets


def capture(target, state):
    path = state / (target['screen'] + '-' + str(target['window']) + '.txt')
    path.unlink(missing_ok=True)
    command(['screen', '-S', target['screen'], '-p', str(target['window']), '-X', 'hardcopy', str(path)])
    for _ in range(30):
        if path.exists() and path.stat().st_size:
            path.chmod(0o600)
            return path.read_text(errors='replace')
        time.sleep(.05)
    raise RuntimeError('Screen capture unavailable.')


def stuff(target, text):
    command(['screen', '-S', target['screen'], '-p', str(target['window']), '-X', 'stuff', text])


def enter_command(target, text):
    stuff(target, text)
    time.sleep(.4)
    stuff(target, '\r')


def busy(text):
    return bool(re.search(r'Working \(|Waiting for background|Compacting context|esc to interrupt',
                          '\n'.join(text.splitlines()[-12:]), re.I))


def empty_composer(text):
    return any(re.fullmatch(r'[^\w]{1,6}Ask Codex to do anything\s*', line)
               for line in text.splitlines()[-7:])


def launch_arguments(target, config, continuation=None):
    thread = target['thread']
    if target['backend'] == 'copilot':
        result = [str(Path.home() / '.local/bin/codex-copilot'), '--state-dir', target['home'],
                  '-C', thread['cwd'], '--model', thread['model'], '--reasoning', thread['reasoning_effort'] or 'max']
    else:
        result = [config['codex_bin'], '-C', thread['cwd'], '--model', thread['model'],
                  '-c', 'model_reasoning_effort=' + json.dumps(thread['reasoning_effort'] or 'max'), '--yolo']
    result += ['resume', thread['id']]
    if continuation:
        result.append(continuation)
    return result


def continuation_policy(before, interrupted, continuation):
    if before and before['status'] in ('active', 'blocked'):
        return None, continuation
    if interrupted and not continuation:
        continuation = ('Continue the interrupted user task after this harness runtime upgrade. '
                        'The same native thread and files are preserved. Old PTY/process handles may no longer exist; '
                        'inspect saved tool results and current authoritative state before rerunning commands. '
                        'Preserve the existing goal objective, explicit user pauses and native budgets.')
    return continuation, None


def reload_target(target, config, state, drain_seconds=45, continuation=None):
    if not alive(target):
        raise RuntimeError('The inventoried native process changed; reinventory before restarting.')
    home = Path(target['home'])
    current = root_thread(home, target['pid'], target['thread']['id'] if target['controller'] else None)
    if not current or current['id'] != target['thread']['id']:
        raise RuntimeError('The live thread changed; refusing to restart a different session.')
    target['thread'] = current
    before = goal(home, current['id'])
    text = capture(target, state)
    interrupted_for_update = False
    if not empty_composer(text):
        raise RuntimeError('Pending input or a dialog must be preserved; reload deferred.')
    deadline = time.monotonic() + drain_seconds
    while busy(text) and time.monotonic() < deadline:
        time.sleep(2)
        text = capture(target, state)
    if 'Compacting context' in '\n'.join(text.splitlines()[-12:]):
        raise RuntimeError('Compaction is still running; reload deferred without interruption.')
    if busy(text):
        # An explicit update/reload request authorizes a native turn interrupt.
        # Wait for Codex to save the interruption before quitting its process.
        stuff(target, '\x1b')
        interrupted_for_update = True
        for _ in range(40):
            time.sleep(.25)
            text = capture(target, state)
            if not busy(text):
                break
    if busy(text) or not empty_composer(text) or not alive(target):
        raise RuntimeError('Native turn did not reach a safe quit point; reload deferred.')
    enter_command(target, '/quit')
    deadline = time.monotonic() + 60
    while alive(target) or (target.get('launcher_process') and alive(target['launcher_process'])):
        if time.monotonic() >= deadline:
            raise RuntimeError('Old writer/launcher has not exited; no concurrent resume was started.')
        time.sleep(.2)
    # A positional prompt suppresses Codex's resume-goal dialog. Restore active
    # goals first; otherwise the interruption's temporary pause is mistaken for
    # a human pause. A controller continuation can be queued after restoration.
    initial_continuation, deferred_continuation = continuation_policy(before, interrupted_for_update, continuation)
    enter_command(target, shlex.join(launch_arguments(target, config, initial_continuation)))
    deadline = time.monotonic() + 90
    selected = False
    updated = None
    replacement_seen_at = None
    while time.monotonic() < deadline:
        time.sleep(.5)
        text = capture(target, state)
        if 'Resume paused goal?' in text and not selected:
            if not before or before['status'] not in ('active', 'blocked'):
                stuff(target, '\x1b[B')
                time.sleep(.2)
            stuff(target, '\r')
            selected = True
        for candidate in inventory(current['id'] if target['controller'] else None):
            if candidate['screen'] == target['screen'] and candidate['window'] == target['window']:
                if candidate['pid'] != target['pid'] and candidate['thread']['id'] == current['id']:
                    updated = candidate
                    if replacement_seen_at is None:
                        replacement_seen_at = time.monotonic()
                    break
        current_goal = goal(home, current['id']) if updated else None
        goal_ready = (not before or before['status'] in ('complete', 'usage_limited')
                      or (current_goal and current_goal['status'] == 'active' and before['status'] in ('active', 'blocked'))
                      or (before['status'] == 'paused' and (selected or continuation) and current_goal and current_goal['status'] == 'paused'))
        if (updated and replacement_seen_at is not None and time.monotonic() - replacement_seen_at >= 3
                and goal_ready and 'Resume paused goal?' not in text
                and ('Ask Codex to do anything' in text or busy(text))):
            break
    if not updated or not goal_ready or 'Resume paused goal?' in text:
        raise RuntimeError('Reload did not verify the same native thread in the same Screen window.')
    executable = Path(os.readlink(Path('/proc') / str(updated['pid']) / 'exe'))
    if executable.resolve() != Path(config['codex_bin']).resolve():
        raise RuntimeError('The replacement process is not using the updated Codex executable.')
    after = goal(home, current['id'])
    if before and (not after or after['goal_id'] != before['goal_id']):
        raise RuntimeError('Goal identity changed during reload.')
    if before and before['status'] in ('paused', 'complete', 'usage_limited') and after['status'] != before['status']:
        raise RuntimeError('A paused or terminal goal changed status during reload.')
    if deferred_continuation:
        text = capture(updated, state)
        if not empty_composer(text):
            raise RuntimeError('Controller continuation was not queued over pending input.')
        enter_command(updated, deferred_continuation)
    return {'screen': target['screen'], 'window': target['window'], 'thread_id': current['id'],
            'old_pid': target['pid'], 'new_pid': updated['pid'], 'model': current['model'],
            'reasoning_effort': current['reasoning_effort'], 'goal_before': before, 'goal_after': after,
            'interrupted_for_update': interrupted_for_update,
            'status': 'reloaded-exact-thread'}


def save(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--state-dir', type=Path, required=True)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--only', help='Exact Screen name or suffix to reload.')
    parser.add_argument('--controller-thread', default=os.environ.get('CODEX_THREAD_ID'))
    parser.add_argument('--wait-controller-idle', action='store_true')
    parser.add_argument('--continuation')
    args = parser.parse_args()
    os.umask(0o077)
    args.state_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    config = json.loads(args.config.read_text())
    controller_guard = None
    if args.wait_controller_idle:
        controller_guard = (args.config.parent / 'controller-handoff.lock').open('a')
        fcntl.flock(controller_guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
    with (args.state_dir / 'reload.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        targets = inventory(args.controller_thread)
        if args.only:
            targets = [t for t in targets if t['screen'] == args.only or t['screen'].split('.', 1)[1] == args.only]
            if len(targets) != 1:
                raise RuntimeError('Requested Screen is missing or ambiguous.')
        save(args.state_dir / 'inventory.json', targets)
        if not args.apply:
            print(json.dumps(targets))
            return
        results = []
        for target in sorted(targets, key=lambda t: (t['controller'], t['screen'])):
            if target['controller']:
                if not args.wait_controller_idle:
                    results.append({'screen': target['screen'], 'status': 'controller-deferred', 'thread_id': target['thread']['id']})
                    continue
                # Two idle captures after the controlling turn completes keep
                # tool output durable before the updater reloads its own TUI.
                deadline = time.monotonic() + 7200
                stable = 0
                while time.monotonic() < deadline and stable < 2:
                    text = capture(target, args.state_dir)
                    stable = stable + 1 if empty_composer(text) and not busy(text) else 0
                    time.sleep(2)
                if stable < 2:
                    raise RuntimeError('Controller never became idle; no restart was attempted.')
            try:
                config = json.loads(args.config.read_text())
                result = reload_target(target, config, args.state_dir, continuation=args.continuation if target['controller'] else None)
            except Exception as error:
                result = {'screen': target['screen'], 'thread_id': target['thread']['id'],
                          'status': 'reload-failed', 'reason': str(error) if type(error) is RuntimeError else type(error).__name__}
            results.append(result)
            save(args.state_dir / 'reload-report.json', {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'results': results})
            print(json.dumps(result), flush=True)
        save(args.state_dir / 'reload-report.json', {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'results': results})
        return int(any(result['status'] == 'reload-failed' for result in results))


if __name__ == '__main__':
    raise SystemExit(main())
