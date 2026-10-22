#!/usr/bin/python3
"""Bounded, opt-in Screen recovery for an exact native goal's transport failure.

Healthy checks make no model calls. Native state is read-only; the only recovery
command is /goal resume in the existing, verified, detached Screen window.
"""

import argparse
import datetime
import fcntl
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import time

TAIL_BYTES = 2 * 1024**2
TRANSIENT = re.compile(
    r'stream disconnected before completion: Copilot stream ended before completion '
    r'\((COPILOT_UNEXPECTED_EOF|UND_ERR_SOCKET|UND_ERR_BODY_TIMEOUT|ECONNRESET|ETIMEDOUT)\)\.'
)


def read_native(config):
    home = Path(config['codex_home'])
    with sqlite3.connect((home / 'goals_1.sqlite').as_uri() + '?mode=ro',
                         uri=True, timeout=5) as connection:
        connection.row_factory = sqlite3.Row
        row = connection.execute(
            'SELECT thread_id, goal_id, status, token_budget, tokens_used, '
            'time_used_seconds, updated_at_ms FROM thread_goals WHERE thread_id=?',
            (config['thread_id'],)).fetchone()
    goal = dict(row) if row else None
    with sqlite3.connect((home / 'state_5.sqlite').as_uri() + '?mode=ro',
                         uri=True, timeout=5) as connection:
        row = connection.execute('SELECT rollout_path FROM threads WHERE id=?',
                                 (config['thread_id'],)).fetchone()
    return goal, Path(row[0]) if row else None


def rollout_evidence(path):
    """Read a bounded suffix; absent/truncated evidence can never authorize input."""
    result = {'completion': None, 'started_at': 0, 'tool_result_at': 0,
              'user_message_at': 0}
    with path.open('rb') as source:
        source.seek(max(0, path.stat().st_size - TAIL_BYTES))
        lines = source.read(TAIL_BYTES).splitlines()
        for line in lines:
            try:
                event = json.loads(line)
                timestamp = datetime.datetime.fromisoformat(
                    event['timestamp'].replace('Z', '+00:00')).timestamp()
                payload = event['payload']
            except (ValueError, KeyError, TypeError):
                continue
            if event.get('type') == 'event_msg':
                kind = payload.get('type')
                if kind == 'task_complete':
                    error = payload.get('error') or {}
                    match = TRANSIENT.fullmatch(error.get('message', ''))
                    result['completion'] = {
                        'at': timestamp, 'failure_code': match[1] if match else None}
                elif kind == 'task_started':
                    result['started_at'] = timestamp
                elif kind in ('user_message', 'turn_aborted'):
                    result['user_message_at'] = timestamp
            elif event.get('type') == 'response_item' and payload.get('type') in (
                    'function_call_output', 'custom_tool_call_output'):
                result['tool_result_at'] = timestamp
    return result


def blocked_reason(config, goal, evidence, ledger, now):
    if not goal or goal['goal_id'] != config['goal_id']:
        return 'goal-absent-or-replaced'
    if goal['status'] != 'blocked':
        return 'goal-' + goal['status']
    if goal['token_budget'] is not None and goal['tokens_used'] >= goal['token_budget']:
        return 'native-budget-reached'
    review = config.get('review_at_tokens')
    if review is not None and goal['tokens_used'] >= review:
        return 'human-strategy-review-required'
    completion = evidence['completion']
    if not completion or not completion['failure_code']:
        return 'no-confirmed-transport-failure'
    failed_at = completion['at']
    if (failed_at < evidence['started_at'] or failed_at < evidence['user_message_at']
            or abs(goal['updated_at_ms'] / 1000 - failed_at) > 30):
        return 'failure-is-not-current'
    if not 60 <= now - failed_at <= config.get('max_failure_age_seconds', 86400):
        return 'failure-too-new-or-stale'
    if ledger.get('consecutive_attempts', 0) >= 2:
        return 'recovery-exhausted-needs-review'
    attempts = ledger.get('attempts', [])
    if attempts and now - attempts[-1]['at'] < 900:
        return 'recovery-cooldown'
    if sum(item['at'] > now - 86400 for item in attempts) >= 6:
        return 'daily-recovery-limit'
    if ledger.get('last_failure_at') == failed_at:
        return 'failure-already-handled'
    return None


def detached_screen(name):
    output = subprocess.run(['screen', '-ls'], capture_output=True, text=True,
                            check=False, timeout=10).stdout
    matches = re.findall(r'^\s*(\d+\.' + re.escape(name) + r')\s+.*\((Attached|Detached)\)',
                         output, re.M)
    if len(matches) != 1 or matches[0][1] != 'Detached':
        raise RuntimeError('screen-missing-ambiguous-or-attached')
    return matches[0][0]


def native_identity(config, session, rollout, proc=Path('/proc')):
    """Require one foreground native process with this rollout open in this window.

    Command-line resume IDs alone are insufficient: /new can change the live
    thread while the command line still contains the previous thread's ID.
    """
    matches = []
    screen_pid = int(session.split('.', 1)[0])
    for entry in proc.iterdir():
        if not entry.name.isdigit():
            continue
        try:
            if entry.stat().st_uid != os.getuid():
                continue
            command = (entry / 'cmdline').read_bytes().split(b'\0')
            if not command[0] or Path(os.fsdecode(command[0])).name != 'codex':
                continue
            if b'exec' in command:
                continue
            environment = dict(item.split(b'=', 1) for item in
                               (entry / 'environ').read_bytes().split(b'\0') if b'=' in item)
            if (environment.get(b'STY') != session.encode()
                    or environment.get(b'WINDOW') != str(config.get('window', 0)).encode()
                    or environment.get(b'CODEX_HOME') != os.fsencode(config['codex_home'])):
                continue
            fields = (entry / 'stat').read_text().rsplit(')', 1)[1].split()
            if fields[2] != fields[5]:  # pgrp must own the terminal foreground
                continue
            parent = int(fields[1])
            for _ in range(20):
                if parent in (screen_pid, 0, 1):
                    break
                parent = int((proc / str(parent) / 'stat').read_text().rsplit(')', 1)[1].split()[1])
            if parent != screen_pid:
                continue
            rollouts = {Path(os.readlink(fd)) for fd in (entry / 'fd').iterdir()
                        if 'rollout-' in os.readlink(fd)}
            if rollouts != {rollout}:
                continue
            matches.append((int(entry.name), fields[19]))  # PID + Linux start time
        except (OSError, ValueError, IndexError):
            continue
    if len(matches) != 1:
        raise RuntimeError('native-thread-window-or-foreground-not-verified')
    return matches[0]


def capture_screen(session, window, state):
    path = state / 'screen-current.txt'
    path.unlink(missing_ok=True)
    subprocess.run(['screen', '-S', session, '-p', str(window), '-X', 'hardcopy', str(path)],
                   check=True, timeout=10)
    for _ in range(20):
        if path.exists() and path.stat().st_size:
            path.chmod(0o600)
            return path.read_text(errors='replace')
        time.sleep(.05)
    raise RuntimeError('screen-capture-unavailable')


def native_started_at(identity):
    boot = next(int(line.split()[1]) for line in Path('/proc/stat').read_text().splitlines()
                if line.startswith('btime '))
    return boot + int(identity[1]) / os.sysconf('SC_CLK_TCK')


def idle_stalled_prompt(text):
    # Restrict automation to this known empty composer. Different UI versions,
    # pending text, dialogs, attachments and busy compaction require a human.
    footer = text.splitlines()[-7:]
    return (any(re.fullmatch(r'[^\w]{1,6}Ask Codex to do anything\s*', line) for line in footer)
            and any('Goal stalled (/goal resume)' in line for line in footer)
            and not re.search(r'Working|Waiting for background|Compacting context|esc to interrupt|\[Pasted|\[Image', '\n'.join(text.splitlines()[-12:])))


def save_json(path, value):
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def check(config, state, apply=False):
    now = time.time()
    ledger_path = state / 'recovery.json'
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    goal, rollout = read_native(config)
    result = {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'thread_id': config['thread_id'], 'goal': goal}
    if not goal or goal['goal_id'] != config['goal_id'] or not rollout:
        return {**result, 'status': 'goal-absent-or-replaced'}
    evidence = rollout_evidence(rollout) if goal['status'] == 'blocked' or ledger.get('consecutive_attempts') else {}
    if (ledger.get('attempts') and evidence.get('tool_result_at', 0) > ledger['attempts'][-1]['at']):
        ledger['consecutive_attempts'] = 0
        if apply:
            save_json(ledger_path, ledger)
    if goal['status'] != 'blocked':
        return {**result, 'status': 'goal-' + goal['status']}
    reason = blocked_reason(config, goal, evidence, ledger, now)
    if reason:
        return {**result, 'status': reason}
    result['failure'] = evidence['completion']
    free = os.statvfs(config['project'])
    result['available_gib'] = round(free.f_bavail * free.f_frsize / 1024**3, 2)
    if result['available_gib'] < config.get('min_free_gib', 4):
        return {**result, 'status': 'disk-pressure-needs-review'}
    session = detached_screen(config['screen_name'])
    identity = native_identity(config, session, rollout)
    # A newly launched TUI may offer "Leave paused" for an older blocked goal
    # without changing its stored status. Never override that startup choice.
    if evidence['completion']['at'] < native_started_at(identity) - 1:
        return {**result, 'status': 'failure-precedes-current-native-process'}
    if not idle_stalled_prompt(capture_screen(session, config.get('window', 0), state)):
        return {**result, 'status': 'screen-busy-or-composer-not-empty'}
    if not apply:
        return {**result, 'status': 'would-resume', 'native_pid': identity[0]}
    # Recheck identity and persisted state immediately before any terminal input.
    current, current_rollout = read_native(config)
    if current != goal or current_rollout != rollout or detached_screen(config['screen_name']) != session:
        return {**result, 'status': 'state-changed-before-resume'}
    if native_identity(config, session, rollout) != identity:
        return {**result, 'status': 'native-process-changed-before-resume'}
    if not idle_stalled_prompt(capture_screen(session, config.get('window', 0), state)):
        return {**result, 'status': 'screen-changed-before-resume'}
    # Persist the allowance before sending input so a crash cannot replay it.
    ledger['attempts'] = [item for item in ledger.get('attempts', []) if item['at'] > now - 86400]
    ledger['attempts'].append({'at': now, 'failure_at': evidence['completion']['at']})
    ledger['consecutive_attempts'] = ledger.get('consecutive_attempts', 0) + 1
    ledger['last_failure_at'] = evidence['completion']['at']
    save_json(ledger_path, ledger)
    command = ['screen', '-S', session, '-p', str(config.get('window', 0)), '-X', 'stuff']
    subprocess.run([*command, '/goal resume'], check=True, timeout=10)
    time.sleep(.4)  # Codex paste detection requires a separate Enter.
    current, _ = read_native(config)
    if (current != goal or detached_screen(config['screen_name']) != session
            or native_identity(config, session, rollout) != identity):
        return {**result, 'status': 'state-changed-before-enter-needs-review'}
    pending = capture_screen(session, config.get('window', 0), state).splitlines()[-7:]
    if not any(re.fullmatch(r'[^\w]{1,6}/goal resume\s*', line) for line in pending):
        return {**result, 'status': 'composer-changed-before-enter-needs-review'}
    subprocess.run([*command, '\r'], check=True, timeout=10)
    # Submission is not successful inference. Verify native acceptance only.
    for _ in range(16):
        time.sleep(.25)
        after, _ = read_native(config)
        if after and after['goal_id'] == config['goal_id'] and after['status'] == 'active':
            return {**result, 'status': 'resume-accepted', 'native_pid': identity[0]}
        if not after or after['goal_id'] != config['goal_id'] or after['status'] != 'blocked':
            break
    return {**result, 'status': 'resume-not-confirmed-needs-review'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, required=True)
    parser.add_argument('--apply', action='store_true', help='Otherwise inspect without resuming.')
    args = parser.parse_args()
    os.umask(0o077)
    config = json.loads(args.config.read_text())
    state = Path(config['state_dir'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'watch.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status': 'another-check-is-running'}))
            return 0
        try:
            result = check(config, state, args.apply)
        except Exception as error:
            # Raw OS/terminal errors may contain sensitive data. Keep fixed
            # locally generated guards or an exception class, never raw payloads.
            reason = str(error) if type(error) is RuntimeError and re.fullmatch('[a-z-]+', str(error)) else type(error).__name__
            result = {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
                      'status': 'check-failed', 'reason': reason}
        save_json(state / 'latest.json', result)
        alert = result['status'] not in ('goal-active', 'goal-paused', 'goal-complete',
                                         'goal-completed', 'goal-usage_limited',
                                         'goal-absent-or-replaced', 'would-resume',
                                         'resume-accepted', 'recovery-cooldown')
        if alert:
            (state / 'alert.txt').write_text(json.dumps(result, indent=2) + '\n')
        else:
            (state / 'alert.txt').unlink(missing_ok=True)
        print(json.dumps(result))
        return int(alert)


if __name__ == '__main__':
    raise SystemExit(main())
