#!/usr/bin/python3
"""Bounded, opt-in Screen recovery for native transport and context failures.

Healthy checks make no model calls. Native state is read-only; recovery uses the
existing, verified, detached Screen window. Large failed histories may opt into
native /compact before /goal resume, without lowering the model context limit.
"""

import argparse
import datetime
import fcntl
import json
import math
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
EARLY_CONNECTION = re.compile(
    r'unexpected status 502 Bad Gateway: Connecting to Copilot failed before a response '
    r'\((ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ENETUNREACH|'
    r'EHOSTUNREACH|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)\)\., '
    r'url: http://127\.0\.0\.1:[1-9][0-9]{0,4}/v1/responses'
)


def failure_code(error):
    if not isinstance(error, dict):
        return None
    kind = error.get('codex_error_info')
    if kind == 'context_window_exceeded':
        return 'CONTEXT_WINDOW_EXCEEDED'
    if kind in ('internal_server_error', 'server_overloaded'):
        return 'UPSTREAM_SERVER_ERROR'
    message = error.get('message')
    # Before headers, Codex wraps the bridge's fixed connection error as a typed
    # HTTP 502. Require both forms; a generic gateway or denial is not recovery
    # evidence. Pause, goal freshness and bounded-attempt guards still apply.
    if kind == {'http_connection_failed': {'http_status_code': 502}}:
        match = EARLY_CONNECTION.fullmatch(message) if isinstance(message, str) else None
        return match[1] if match else None
    match = TRANSIENT.fullmatch(message) if isinstance(message, str) else None
    return match[1] if match else None


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
              'user_message_at': 0, 'compacted_at': 0,
              'input_tokens': None, 'context_window': None}
    with path.open('rb') as source:
        source.seek(max(0, path.stat().st_size - TAIL_BYTES))
        lines = source.read(TAIL_BYTES).splitlines()
        for line in lines:
            try:
                event = json.loads(line)
                if not isinstance(event, dict) or not isinstance(event.get('timestamp'), str):
                    continue
                at = datetime.datetime.fromisoformat(event['timestamp'].replace('Z', '+00:00'))
                if at.tzinfo is None:
                    continue
                timestamp = at.timestamp()
                payload = event['payload']
                if not isinstance(payload, dict):
                    continue
            except (ValueError, KeyError, TypeError):
                continue
            if event.get('type') == 'event_msg':
                kind = payload.get('type')
                if kind == 'task_complete':
                    error = payload.get('error') or {}
                    # Native Codex zeros its token counters when context is
                    # exhausted. Use its typed error, never prose or that zero,
                    # to authorize local compaction after a confirmed overflow.
                    result['completion'] = {
                        'at': timestamp, 'failure_code': failure_code(error),
                        'failed': bool(error)}
                elif kind == 'task_started':
                    result['started_at'] = timestamp
                elif kind in ('user_message', 'turn_aborted'):
                    result['user_message_at'] = timestamp
                elif kind == 'token_count':
                    info = payload.get('info') or {}
                    if not isinstance(info, dict):
                        continue
                    usage = info.get('last_token_usage') or {}
                    if not isinstance(usage, dict):
                        continue
                    for key, value in [('input_tokens', usage.get('input_tokens')),
                                       ('context_window', info.get('model_context_window'))]:
                        if type(value) in (int, float) and math.isfinite(value) and value >= 0:
                            result[key] = value
            elif event.get('type') == 'compacted':
                result['compacted_at'] = timestamp
            elif event.get('type') == 'response_item' and payload.get('type') in (
                    'function_call_output', 'custom_tool_call_output'):
                result['tool_result_at'] = timestamp
    return result


def goal_guard(config, goal):
    if not goal or goal['goal_id'] != config['goal_id']:
        return 'goal-absent-or-replaced'
    if goal['status'] != 'blocked':
        return 'goal-' + goal['status']
    if goal['token_budget'] is not None and goal['tokens_used'] >= goal['token_budget']:
        return 'native-budget-reached'
    return None


def blocked_reason(config, goal, evidence, ledger, now):
    reason = goal_guard(config, goal)
    if reason:
        return reason
    if ledger.get('halted_reason'):
        return ledger['halted_reason']
    completion = evidence['completion']
    if not completion or not completion['failure_code']:
        return 'no-confirmed-recoverable-failure'
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
            rollouts = set()
            for fd in (entry / 'fd').iterdir():
                try:
                    target = os.readlink(fd)
                except FileNotFoundError:
                    # Network/tool descriptors can close during inspection.
                    # The exact live rollout descriptor is still mandatory.
                    continue
                if 'rollout-' in target:
                    rollouts.add(Path(target))
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


def needs_compaction(config, evidence):
    if (evidence.get('completion') or {}).get('failure_code') == 'CONTEXT_WINDOW_EXCEEDED':
        return True
    fraction = config.get('compact_failure_context_fraction', .65)
    tokens, window = evidence.get('input_tokens'), evidence.get('context_window')
    return bool(config.get('compact_after_transport_failure')
                and isinstance(fraction, (int, float)) and .5 <= fraction <= 1
                and isinstance(tokens, (int, float)) and isinstance(window, (int, float))
                and window > 0 and tokens >= fraction * window)


def submit_command(config, state, goal, rollout, session, identity, text):
    assert text in ('/goal resume', '/compact')
    observed = rollout_evidence(rollout)
    command = ['screen', '-S', session, '-p', str(config.get('window', 0)), '-X', 'stuff']
    subprocess.run([*command, text], check=True, timeout=10)
    time.sleep(.4)  # Codex paste detection requires a separate Enter.
    current, _ = read_native(config)
    latest = rollout_evidence(rollout)
    if (current != goal or detached_screen(config['screen_name']) != session
            or native_identity(config, session, rollout) != identity
            or latest['started_at'] != observed['started_at']
            or latest['user_message_at'] != observed['user_message_at']):
        return 'state-changed-before-enter-needs-review'
    pending = capture_screen(session, config.get('window', 0), state).splitlines()[-7:]
    if not any(re.fullmatch(r'[^\w]{1,6}' + re.escape(text) + r'\s*', line) for line in pending):
        return 'composer-changed-before-enter-needs-review'
    subprocess.run([*command, '\r'], check=True, timeout=10)
    return None


def wait_for_active(config):
    # Submission is not successful inference. Verify native acceptance only.
    for _ in range(16):
        time.sleep(.25)
        after, _ = read_native(config)
        if after and after['goal_id'] == config['goal_id'] and after['status'] == 'active':
            return 'resume-accepted'
        if not after or after['goal_id'] != config['goal_id'] or after['status'] != 'blocked':
            break
    return 'resume-not-confirmed-needs-review'


def request_resume(config, state, goal, rollout, session, identity, ledger, now):
    pending = ledger.get('pending_resume', {})
    ledger['pending_resume'] = {
        'at': now, 'goal_id': goal['goal_id'], 'goal_updated_at_ms': goal['updated_at_ms'],
        'native_identity': list(identity), 'submissions': pending.get('submissions', 0) + 1}
    # Keep the transaction until native state acknowledges it. A process crash
    # or swallowed terminal input must not lose a completed compaction forever.
    save_json(state / 'recovery.json', ledger)
    issue = submit_command(config, state, goal, rollout, session, identity, '/goal resume')
    status = issue or wait_for_active(config)
    if status == 'resume-accepted':
        ledger.pop('pending_resume', None)
        save_json(state / 'recovery.json', ledger)
    elif issue:
        ledger['halted_reason'] = issue
        save_json(state / 'recovery.json', ledger)
    return {'status': status, 'native_pid': identity[0]}


def continue_resume(config, state, goal, rollout, evidence, ledger, now, apply):
    pending = ledger['pending_resume']
    if (pending['goal_id'] != goal['goal_id']
            or pending['goal_updated_at_ms'] != goal['updated_at_ms']
            or evidence.get('user_message_at', 0) > pending['at']):
        return {'status': 'resume-state-changed-needs-review'}
    if ledger.get('halted_reason'):
        return {'status': ledger['halted_reason']}
    if now - pending['at'] < 60:
        return {'status': 'resume-confirmation-pending'}
    if pending['submissions'] >= 2:
        return {'status': 'resume-not-confirmed-needs-review'}
    free = os.statvfs(config['project'])
    if free.f_bavail * free.f_frsize / 1024**3 < config.get('min_free_gib', 4):
        return {'status': 'disk-pressure-needs-review'}
    session = detached_screen(config['screen_name'])
    identity = native_identity(config, session, rollout)
    if list(identity) != pending['native_identity']:
        return {'status': 'resume-process-changed-needs-review'}
    if not idle_stalled_prompt(capture_screen(session, config.get('window', 0), state)):
        return {'status': 'resume-waiting-for-idle-screen'}
    if not apply:
        return {'status': 'would-retry-unacknowledged-resume', 'native_pid': identity[0]}
    current, current_rollout = read_native(config)
    if (current != goal or current_rollout != rollout
            or native_identity(config, session, rollout) != identity
            or detached_screen(config['screen_name']) != session):
        return {'status': 'resume-state-changed-needs-review'}
    return request_resume(config, state, goal, rollout, session, identity, ledger, now)


def continue_compaction(config, state, goal, rollout, evidence, ledger, now, apply):
    pending = ledger['pending_compaction']

    def halt(reason):
        if apply:
            ledger.pop('pending_compaction', None)
            ledger['halted_reason'] = reason
            save_json(state / 'recovery.json', ledger)
        return {'status': reason}

    if (pending['goal_id'] != goal['goal_id']
            or pending['goal_updated_at_ms'] != goal['updated_at_ms']
            or evidence.get('user_message_at', 0) > pending['at']):
        return halt('compaction-state-changed-needs-review')
    free = os.statvfs(config['project'])
    if free.f_bavail * free.f_frsize / 1024**3 < config.get('min_free_gib', 4):
        return {'status': 'disk-pressure-needs-review'}
    session = detached_screen(config['screen_name'])
    identity = native_identity(config, session, rollout)
    if list(identity) != pending['native_identity']:
        return halt('compaction-process-changed-needs-review')
    completion = evidence.get('completion')
    if completion and completion['at'] >= pending['at'] and completion.get('failed'):
        return halt('compaction-failed-needs-review')
    compacted_at = evidence.get('compacted_at', 0)
    ready = (compacted_at >= pending['at'] and completion
             and completion['at'] >= compacted_at and completion.get('failed') is False
             and evidence['started_at'] <= completion['at'])
    screen = capture_screen(session, config.get('window', 0), state)
    if now - pending['at'] > 3600 and not ready:
        # Keep observing an existing compaction without interrupting it or
        # submitting another one. A delayed cron run can still verify success.
        return {'status': 'compaction-timeout-needs-review'}
    if not ready:
        if 'Compacting context' in '\n'.join(screen.splitlines()[-12:]):
            return {'status': 'compaction-in-progress'}
        if now - pending['at'] < 60:
            return {'status': 'compaction-in-progress'}
        return halt('compaction-not-confirmed-needs-review')
    if not idle_stalled_prompt(screen):
        return {'status': 'compaction-waiting-for-idle-screen'}
    if not apply:
        return {'status': 'would-resume-after-compaction', 'native_pid': identity[0]}
    current, current_rollout = read_native(config)
    if (current != goal or current_rollout != rollout
            or detached_screen(config['screen_name']) != session
            or native_identity(config, session, rollout) != identity
            or not idle_stalled_prompt(capture_screen(session, config.get('window', 0), state))):
        return halt('compaction-state-changed-needs-review')
    # Atomically replace compaction bookkeeping with a resume transaction.
    ledger.pop('pending_compaction')
    return request_resume(config, state, goal, rollout, session, identity, ledger, now)


def check(config, state, apply=False):
    now = time.time()
    ledger_path = state / 'recovery.json'
    ledger = json.loads(ledger_path.read_text()) if ledger_path.exists() else {}
    goal, rollout = read_native(config)
    result = {'checked_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'thread_id': config['thread_id'], 'goal': goal}
    if not goal or not rollout:
        return {**result, 'status': 'goal-absent-or-replaced'}
    configured_goal = config['goal_id']
    if goal['goal_id'] != configured_goal:
        if not config.get('follow_current_goal'):
            return {**result, 'status': 'goal-absent-or-replaced'}
        # Explicitly watch the current goal of this one pinned native thread.
        # This never changes native goal state; all pause, budget, live writer,
        # detached Screen and empty-composer guards still run before any input.
        config = {**config, 'goal_id': goal['goal_id']}
    if ledger.get('goal_id', configured_goal) != goal['goal_id']:
        # A replaced goal must not inherit a pending command or halted incident.
        # Keep the cross-goal daily allowance and cooldown so replacing a goal
        # cannot turn bounded recovery into an unbounded model-call loop.
        ledger = {'goal_id': goal['goal_id'], 'attempts': ledger.get('attempts', [])}
        if apply and ledger_path.exists():
            save_json(ledger_path, ledger)
    else:
        ledger = {**ledger, 'goal_id': goal['goal_id']}
    evidence = rollout_evidence(rollout) if goal['status'] == 'blocked' or ledger.get('consecutive_attempts') or ledger.get('pending_compaction') or ledger.get('pending_resume') else {}
    if (ledger.get('attempts') and evidence.get('tool_result_at', 0) > ledger['attempts'][-1]['at']):
        ledger['consecutive_attempts'] = 0
        ledger.pop('halted_reason', None)
        if apply:
            save_json(ledger_path, ledger)
    if goal['status'] != 'blocked':
        changed = ledger.pop('pending_compaction', None) or ledger.get('pending_resume')
        ledger.pop('pending_resume', None)
        if changed and apply:
            save_json(ledger_path, ledger)
        return {**result, 'status': 'goal-' + goal['status']}
    guard = goal_guard(config, goal)
    if guard:
        return {**result, 'status': guard}
    if ledger.get('pending_compaction'):
        return {**result, **continue_compaction(config, state, goal, rollout, evidence, ledger, now, apply)}
    if ledger.get('pending_resume'):
        pending = ledger['pending_resume']
        if evidence['started_at'] > pending['at']:
            # A new native turn proves the command reached Codex. Never replay
            # it over a later inference failure or real project blocker.
            ledger.pop('pending_resume')
            if apply:
                save_json(ledger_path, ledger)
        else:
            return {**result, **continue_resume(config, state, goal, rollout, evidence, ledger, now, apply)}
    completion = evidence.get('completion')
    if completion and evidence['started_at'] > completion['at']:
        return {**result, 'status': 'foreground-turn-in-progress'}
    if completion and completion.get('failed') is False:
        return {**result, 'status': 'goal-blocked-without-runtime-error'}
    reason = blocked_reason(config, goal, evidence, ledger, now)
    if reason:
        if reason in ('no-confirmed-recoverable-failure', 'failure-is-not-current'):
            session = detached_screen(config['screen_name'])
            native_identity(config, session, rollout)
            footer = capture_screen(session, config.get('window', 0), state).splitlines()[-12:]
            if re.search(r'Working \(|Waiting for background|Compacting context', '\n'.join(footer)):
                return {**result, 'status': 'foreground-turn-in-progress'}
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
    compact = needs_compaction(config, evidence)
    if not apply:
        return {**result, 'status': 'would-compact' if compact else 'would-resume', 'native_pid': identity[0]}
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
    ledger['attempts'].append({'at': now, 'failure_at': evidence['completion']['at'],
                               'goal_id': goal['goal_id'],
                               'failure_code': evidence['completion']['failure_code']})
    ledger['consecutive_attempts'] = ledger.get('consecutive_attempts', 0) + 1
    ledger['last_failure_at'] = evidence['completion']['at']
    if compact:
        ledger['pending_compaction'] = {
            'at': now, 'goal_id': goal['goal_id'], 'goal_updated_at_ms': goal['updated_at_ms'],
            'native_identity': list(identity)}
    if not compact:
        return {**result, **request_resume(config, state, goal, rollout, session, identity, ledger, now)}
    save_json(ledger_path, ledger)
    issue = submit_command(config, state, goal, rollout, session, identity, '/compact')
    if issue and compact:
        ledger.pop('pending_compaction', None)
        ledger['halted_reason'] = issue
        save_json(ledger_path, ledger)
    status = issue or 'compaction-requested'
    return {**result, 'status': status, 'native_pid': identity[0]}


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
                                         'would-resume',
                                         'resume-accepted', 'recovery-cooldown', 'would-compact',
                                         'compaction-requested', 'compaction-in-progress',
                                         'foreground-turn-in-progress', 'compaction-waiting-for-idle-screen',
                                         'resume-confirmation-pending', 'resume-waiting-for-idle-screen',
                                         'would-retry-unacknowledged-resume',
                                         'would-resume-after-compaction')
        if alert:
            (state / 'alert.txt').write_text(json.dumps(result, indent=2) + '\n')
        else:
            (state / 'alert.txt').unlink(missing_ok=True)
        print(json.dumps(result))
        return int(alert)


if __name__ == '__main__':
    raise SystemExit(main())
