#!/usr/bin/env python3
"""Local terminal control center for native Codex sessions in GNU Screen."""

import argparse
from concurrent.futures import ThreadPoolExecutor
import curses
import datetime
import fcntl
import json
import math
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

import goal_recovery_watch as recovery
import screen_sessions as screens


def clean(value):
    return ''.join(c if c.isprintable() else ' ' for c in str(value or ''))


def short_number(value):
    if type(value) not in (int, float) or not math.isfinite(value) or value < 0:
        return '-'
    if value >= 1_000_000:
        return f'{value / 1_000_000:.2f}M'
    if value >= 1000:
        return f'{value / 1000:.0f}k'
    return str(int(value))


def age(value, now=None):
    if not value:
        return '-'
    seconds = max(0, int((time.time() if now is None else now) - value))
    if seconds < 60:
        return f'{seconds}s'
    if seconds < 3600:
        return f'{seconds // 60}m'
    return f'{seconds // 3600}h'


def state_for(goal, evidence):
    completion = evidence.get('completion')
    if evidence.get('started_at', 0) > (completion or {}).get('at', 0):
        return 'working'
    if goal and goal['status'] in ('paused', 'complete', 'completed', 'usage_limited'):
        return goal['status']
    if completion and completion.get('failed'):
        return 'overflow' if completion.get('failure_code') == 'CONTEXT_WINDOW_EXCEEDED' else 'error'
    if goal and goal['status'] == 'blocked':
        return 'blocked'
    return goal['status'] if goal else 'idle'


def watch_configs():
    result = {}
    directory = Path.home() / '.config/codex-copilot'
    for path in directory.glob('*-goal-watch.json'):
        try:
            config = json.loads(path.read_text())
            if 'compact_after_transport_failure' in config:
                result[(config['codex_home'], config['thread_id'])] = config
        except (OSError, ValueError, KeyError, TypeError):
            continue
    return result


class Collector:
    def __init__(self):
        self.cache = {}
        self.captures = tempfile.TemporaryDirectory(prefix='cxf-top-')

    def __del__(self):
        try:
            self.captures.cleanup()
        except Exception:
            pass

    def snapshot(self):
        output = subprocess.run(['screen', '-ls'], capture_output=True, text=True, timeout=10, check=False).stdout
        found = re.findall(r'^\s*(\d+\.\S+)\s+.*\((Attached|Detached)\)', output, re.M)
        if not found:
            return []
        attachments = dict(found)
        targets = screens.inventory(os.environ.get('CODEX_THREAD_ID'))
        configured = watch_configs()
        rows = []
        for target in targets:
            thread = target['thread']
            row = {'screen': target['screen'], 'window': target['window'], 'pid': target['pid'],
                   'thread_id': thread['id'], 'cwd': thread['cwd'], 'model': thread['model'],
                   'reasoning': thread['reasoning_effort'], 'backend': target['backend'],
                   'attachment': attachments.get(target['screen'], 'Unknown'), 'verified': True,
                   'target': target, 'goal': target.get('goal'), 'evidence': {}, 'watch': None}
            path = Path(thread['rollout_path'])
            try:
                stat = path.stat()
                identity = (str(path), stat.st_size, stat.st_mtime_ns)
                cached = self.cache.get(thread['id'])
                if not cached or cached[0] != identity:
                    cached = (identity, recovery.rollout_evidence(path))
                    self.cache[thread['id']] = cached
                row['evidence'] = cached[1]
            except (OSError, ValueError, TypeError):
                row['evidence_error'] = 'History metadata unavailable'
            row['state'] = state_for(row['goal'], row['evidence'])
            config = configured.get((target['home'], thread['id']))
            if config:
                try:
                    report = json.loads((Path(config['state_dir']) / 'latest.json').read_text())
                    checked = datetime.datetime.fromisoformat(report['checked_at']).timestamp()
                    # A stale report must never look like current protection.
                    row['watch'] = {'status': report['status'], 'checked_at': checked,
                                    'stale': not -60 <= time.time() - checked <= 180}
                    if row['watch']['stale']:
                        row['watch']['status'] = 'STALE watcher'
                    elif report['status'] == 'compaction-in-progress':
                        row['state'] = 'compacting'
                except (OSError, ValueError, KeyError, TypeError):
                    row['watch'] = {'status': 'watch report unavailable', 'stale': True}
            # A long turn can push its task_started record outside the bounded
            # metadata suffix. The current footer disambiguates that from an
            # idle blocked goal without exposing transcript content in JSON.
            try:
                text = screens.capture(target, Path(self.captures.name))
                footer = '\n'.join(text.splitlines()[-12:])
                if 'Compacting context' in footer:
                    row['state'] = 'compacting'
                elif screens.busy(text):
                    row['state'] = 'working'
            except Exception:
                pass
            rows.append(row)
        represented = {row['screen'] for row in rows}
        # Keep shells, failed launchers and momentarily unverified writers
        # visible instead of silently omitting a Screen from the dashboard.
        for session, attachment in found:
            if session not in represented:
                rows.append({'screen': session, 'window': '0', 'pid': None, 'thread_id': None,
                             'model': None, 'reasoning': None, 'cwd': None, 'backend': None,
                             'attachment': attachment, 'verified': False, 'goal': None,
                             'evidence': {}, 'watch': None, 'state': 'unverified'})
        return sorted(rows, key=lambda row: (row['screen'].split('.', 1)[-1], row['window']))


def context_text(row):
    evidence = row['evidence']
    if row['state'] == 'overflow':
        return 'OVERFLOW'
    tokens, window = evidence.get('input_tokens'), evidence.get('context_window')
    if tokens is None or not window:
        return '-'
    return f'{short_number(tokens)}/{short_number(window)} {tokens / window:.0%}'


def public_rows(rows):
    return [{key: value for key, value in row.items() if key != 'target'} for row in rows]


def text_table(rows):
    lines = ['CXF control center — local native state; no model calls',
             f'{"SCREEN":24} {"STATE":11} {"MODEL / EFFORT":24} {"CONTEXT":20} {"LAST TOOL":9} WATCH']
    for row in rows:
        name = row['screen'].split('.', 1)[-1]
        model = f'{row["model"] or "-"} {row["reasoning"] or ""}'
        watch = row['watch']['status'] if row['watch'] else '-'
        lines.append(f'{clean(name)[:23]:24} {clean(row["state"])[:10]:11} '
                     f'{clean(model)[:23]:24} {context_text(row):20} '
                     f'{age(row["evidence"].get("tool_result_at")):9} {clean(watch)}')
    return '\n'.join(lines)


def recovery_config(target, state_root):
    known = watch_configs().get((target['home'], target['thread']['id']))
    if known:
        return known
    return {'codex_home': target['home'], 'thread_id': target['thread']['id'],
            'goal_id': (target.get('goal') or {}).get('goal_id'), 'follow_current_goal': True,
            'screen_name': target['screen'].split('.', 1)[-1], 'window': target['window'],
            'project': target['thread']['cwd'], 'state_dir': str(state_root / target['thread']['id']),
            'compact_after_transport_failure': True, 'compact_failure_context_fraction': .65,
            'min_free_gib': 4}


def current_target(row):
    if not row.get('verified'):
        raise RuntimeError('Native thread is not verified; attach to inspect this Screen.')
    matches = [t for t in screens.inventory(os.environ.get('CODEX_THREAD_ID'))
               if t['screen'] == row['screen'] and str(t['window']) == str(row['window'])]
    if (len(matches) != 1 or matches[0]['pid'] != row['pid']
            or matches[0]['start'] != row['target']['start']
            or matches[0]['thread']['id'] != row['thread_id']):
        raise RuntimeError('Session changed; refresh and select it again.')
    return matches[0]


def owns_dashboard(pid):
    current = os.getpid()
    for _ in range(50):
        if current == pid:
            return True
        if current <= 1:
            break
        try:
            current = screens.process(current)['parent']
        except OSError:
            break
    return False


def act(row, action, state_root, update_config):
    target = current_target(row)
    config = recovery_config(target, state_root)
    state = Path(config['state_dir'])
    state.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (state / 'watch.lock').open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 'Recovery watcher is busy; retry after it finishes.'
        if action == 'recover':
            result = recovery.check(config, state, apply=True)
            recovery.save_json(state / 'latest.json', result)
            return result['status']
        text = screens.capture(target, state)
        if not screens.empty_composer(text):
            return 'Pending input or a dialog preserved; attach to review it.'
        if 'Compacting context' in '\n'.join(text.splitlines()[-12:]):
            return 'Compaction is running; left uninterrupted.'
        goal = screens.goal(Path(target['home']), target['thread']['id'])
        if action == 'reload':
            if owns_dashboard(target['pid']):
                return 'This dashboard belongs to that session; reload it from a separate terminal.'
            configuration = json.loads(update_config.read_text())
            result = screens.reload_target(target, configuration, state, drain_seconds=5)
            return result['status']
        if action != 'pause' and screens.busy(text):
            return 'A turn is running; use pause or attach before this action.'
        if action in ('pause', 'resume'):
            if not goal:
                return 'This session has no native goal.'
            if action == 'pause' and goal['status'] != 'active':
                return 'Goal is already inactive; current user work was left untouched.'
            if action == 'resume':
                if goal['status'] not in ('blocked', 'paused'):
                    return 'Goal is active or terminal; no resume submitted.'
                if goal['token_budget'] is not None and goal['tokens_used'] >= goal['token_budget']:
                    return 'Native goal budget reached; no resume submitted.'
                evidence = recovery.rollout_evidence(Path(target['thread']['rollout_path']))
                if recovery.needs_compaction(config, evidence):
                    return 'Context needs compaction; use r for guarded recovery or c to compact.'
        command = {'pause': '/goal pause', 'resume': '/goal resume', 'compact': '/compact'}[action]
        if not screens.alive(target):
            return 'Native process changed; no command submitted.'
        screens.stuff(target, command)
        time.sleep(.4)
        current = current_target(row)
        after = screens.goal(Path(target['home']), target['thread']['id'])
        # Token accounting can legitimately advance while pausing an active
        # goal; identity and goal state, rather than counters, guard the input.
        if ((goal or {}).get('goal_id') != (after or {}).get('goal_id')
                or (goal or {}).get('status') != (after or {}).get('status')):
            return 'Goal changed before Enter; pending command preserved for review.'
        footer = screens.capture(current, state).splitlines()[-7:]
        if not any(re.fullmatch(r'[^\w]{1,6}' + re.escape(command) + r'\s*', line) for line in footer):
            return 'Composer changed before Enter; nothing else submitted.'
        screens.stuff(current, '\r')
        return command + ' submitted to the verified native session.'


def draw_line(window, y, text, attribute=0):
    height, width = window.getmaxyx()
    if y < height:
        try:
            window.addnstr(y, 0, clean(text), max(0, width - 1), attribute)
        except curses.error:
            pass


def interactive(window, args):
    try:
        curses.curs_set(0)
    except curses.error:
        pass
    window.timeout(150)
    collector = Collector()
    rows, selected, selection_key, refreshed = [], 0, None, 0
    message, query, editing, frozen, preview = '', '', False, False, False
    future = None
    with ThreadPoolExecutor(max_workers=1) as worker:
        while True:
            if future and future.done():
                try:
                    message = future.result()
                except Exception as error:
                    message = str(error) if type(error) is RuntimeError else type(error).__name__
                future = None
                refreshed = 0
            if not frozen and time.monotonic() - refreshed >= args.interval:
                try:
                    rows = collector.snapshot()
                except Exception as error:
                    message = 'Snapshot unavailable: ' + type(error).__name__
                refreshed = time.monotonic()
            visible = [row for row in rows if query.casefold() in
                       (row['screen'] + ' ' + str(row.get('model')) + ' ' + row['state']).casefold()]
            if selection_key:
                selected = next((i for i, row in enumerate(visible)
                                 if (row['screen'], row['window']) == selection_key), min(selected, len(visible) - 1))
            selected = max(0, min(selected, len(visible) - 1))
            row = visible[selected] if visible else None
            selection_key = (row['screen'], row['window']) if row else None
            window.erase()
            height, width = window.getmaxyx()
            draw_line(window, 0, f' CXF control center | {len(rows)} Screens/windows | '
                      + ('READ ONLY | ' if args.read_only else '')
                      + ('FROZEN' if frozen else datetime.datetime.now().strftime('%H:%M:%S')), curses.A_BOLD)
            draw_line(window, 1, ' Screen                  State       Model / reasoning        Context               Last tool   Watch', curses.A_UNDERLINE)
            table_height = max(1, height - 13)
            start = max(0, selected - table_height + 1)
            for offset, item in enumerate(visible[start:start + table_height]):
                name = item['screen'].split('.', 1)[-1]
                model = f'{item["model"] or "-"} {item["reasoning"] or ""}'
                text = (f' {name[:23]:23} {item["state"][:11]:11} {model[:24]:24} '
                        f'{context_text(item):21} {age(item["evidence"].get("tool_result_at")):11} '
                        + (item['watch']['status'] if item['watch'] else '-'))
                draw_line(window, 2 + offset, text, curses.A_REVERSE if start + offset == selected else 0)
            y = min(height - 10, 3 + min(len(visible), table_height))
            if row:
                goal = row.get('goal') or {}
                draw_line(window, y, ' Selected: ' + row['screen'] + ' / window ' + str(row['window']) + ' [' + row['attachment'] + ']', curses.A_BOLD)
                draw_line(window, y + 1, ' Thread: ' + str(row['thread_id']) + '  PID: ' + str(row['pid']))
                draw_line(window, y + 2, f' Goal: {goal.get("goal_id", "-")}  State: {goal.get("status", "-")}  Tokens: {short_number(goal.get("tokens_used"))} / {short_number(goal.get("token_budget"))}')
                draw_line(window, y + 3, ' Directory: ' + str(row.get('cwd') or '-'))
                completion = row['evidence'].get('completion') or {}
                draw_line(window, y + 4, ' Last failure: ' + str(completion.get('failure_code') or ('unclassified rejection' if completion.get('failed') else 'none')))
                if preview and row.get('verified'):
                    try:
                        capture_dir = args.state_root / 'preview'
                        capture_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
                        capture = screens.capture(row['target'], capture_dir)
                        for index, line in enumerate(capture.splitlines()[-5:]):
                            draw_line(window, y + 1 + index, ' ' + line)
                    except Exception as error:
                        draw_line(window, y + 1, ' Preview unavailable: ' + type(error).__name__)
            draw_line(window, height - 4, (' Filter: ' + query + '_' if editing else ' ' + message), curses.A_BOLD)
            draw_line(window, height - 3, ' Arrows/jk select  / filter  Space freeze  v preview  '
                      + ('' if args.read_only else 'Enter attach  ') + 'q quit')
            draw_line(window, height - 2, ' r recover  c compact  p pause goal  g resume goal  R reload  f refresh'
                      if not args.read_only else ' Read-only mode: recovery, pause, resume, compact and reload controls are disabled.')
            window.refresh()
            key = window.getch()
            if key < 0:
                continue
            if editing:
                if key in (10, 13, 27):
                    editing = False
                elif key in (curses.KEY_BACKSPACE, 127, 8):
                    query = query[:-1]
                elif 32 <= key < 127:
                    query += chr(key)
                selection_key = None
                continue
            if key in (ord('q'), 27):
                if future:
                    message = 'Control action still running; quit after it finishes.'
                    continue
                break
            if key in (curses.KEY_DOWN, ord('j')):
                selected += 1
                selection_key = None
            elif key in (curses.KEY_UP, ord('k')):
                selected -= 1
                selection_key = None
            elif key == ord('/'):
                editing = True
            elif key == ord(' '):
                frozen = not frozen
            elif key == ord('v'):
                preview = not preview
            elif key == ord('f'):
                refreshed = 0
            elif key in (10, 13, ord('a')) and row:
                if args.read_only:
                    message = 'Read-only mode; attachment disabled. Use v for a Screen preview.'
                    continue
                if future:
                    message = 'Wait for the current control action to finish.'
                    continue
                curses.def_prog_mode()
                curses.endwin()
                environment = dict(os.environ)
                environment.pop('STY', None)
                environment.pop('WINDOW', None)
                subprocess.run(['screen', '-x', row['screen'], '-p', str(row['window'])], env=environment, check=False)
                curses.reset_prog_mode()
                window.clear()
                refreshed = 0
                message = 'Returned from Screen; Ctrl-a d detaches an attachment without stopping its work.'
            elif key in map(ord, 'rcpgR') and row:
                if args.read_only:
                    message = 'Read-only mode; no native input submitted.'
                elif future:
                    message = 'One control action is already running.'
                else:
                    action = dict(zip(map(ord, 'rcpgR'), ('recover', 'compact', 'pause', 'resume', 'reload')))[key]
                    message = action.capitalize() + ' in progress for ' + row['screen']
                    future = worker.submit(act, row, action, args.state_root / 'recovery', args.config)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Print one metadata-only JSON snapshot.')
    parser.add_argument('--once', action='store_true', help='Print one table without a terminal UI.')
    parser.add_argument('--read-only', action='store_true', help='Disable all native control actions.')
    parser.add_argument('--interval', type=float, default=2, help='Refresh interval in seconds (0.5–60).')
    parser.add_argument('--config', type=Path, default=Path.home() / '.codex-copilot-pilot/update-config.json')
    parser.add_argument('--state-root', type=Path, default=Path.home() / '.local/state/cxf-control')
    args = parser.parse_args(argv)
    if not .5 <= args.interval <= 60:
        parser.error('--interval must be between 0.5 and 60 seconds')
    os.umask(0o077)
    args.state_root.mkdir(parents=True, exist_ok=True, mode=0o700)
    if args.json or args.once or not (sys.stdin.isatty() and sys.stdout.isatty()):
        try:
            rows = Collector().snapshot()
        except Exception as error:
            print('Local session snapshot unavailable: ' + type(error).__name__, file=sys.stderr)
            return 1
        print(json.dumps(public_rows(rows), indent=2) if args.json else text_table(rows))
        return 0
    try:
        curses.wrapper(interactive, args)
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
