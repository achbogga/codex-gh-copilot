"""Read provider-reported credits; never estimate charges from token prices."""

from decimal import Decimal
import datetime
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import signal
import subprocess
import time

NANO = 1_000_000_000
ECHO_WINDOW = 10
FIELDS = ('input_tokens', 'output_tokens', 'cached_input_tokens',
          'cache_write_input_tokens', 'reasoning_output_tokens')


def timestamp(value):
    try:
        parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def number(value):
    return value if type(value) in (int, float) and math.isfinite(value) and value >= 0 else None


def credit_text(nano, partial=False):
    if nano is None:
        return '-'
    value = Decimal(nano) / NANO
    result = '<0.01' if 0 < value < Decimal('.01') else f'{value:,.2f}'
    return result + ('+' if partial else '')


class Billing:
    def __init__(self, directory=None, sdk_database=None):
        self.directory = Path(directory) if directory else Path.home() / '.local/state/cxf-control/billing'
        self.directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.directory.chmod(0o700)
        self.database = self.directory / 'credits.sqlite'
        self.sdk_database = Path(sdk_database) if sdk_database else Path.home() / '.copilot/session-store.db'
        with self.connect() as db:
            db.execute('pragma journal_mode=WAL')
            db.executescript('''
                CREATE TABLE IF NOT EXISTS sources (
                    path TEXT PRIMARY KEY, thread_id TEXT, identity TEXT, offset INTEGER,
                    metadata TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0, unreadable INTEGER NOT NULL DEFAULT 0);
                CREATE TABLE IF NOT EXISTS native_requests (
                    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, at REAL NOT NULL, model TEXT,
                    input INTEGER NOT NULL, output INTEGER NOT NULL, cached INTEGER NOT NULL,
                    cache_write INTEGER, reasoning INTEGER);
                CREATE TABLE IF NOT EXISTS sdk_charges (
                    id TEXT PRIMARY KEY, model TEXT NOT NULL, at REAL NOT NULL,
                    input INTEGER, output INTEGER, cached INTEGER, cache_write INTEGER,
                    reasoning INTEGER, nano INTEGER);
                CREATE INDEX IF NOT EXISTS sdk_signature ON sdk_charges(input,output,cached,at);
                CREATE TABLE IF NOT EXISTS matches (native_id TEXT PRIMARY KEY, sdk_id TEXT UNIQUE NOT NULL);
                CREATE TABLE IF NOT EXISTS families (root_id TEXT NOT NULL, thread_id TEXT NOT NULL,
                    PRIMARY KEY(root_id,thread_id));
                CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY,value TEXT NOT NULL);
            ''')
            version = db.execute("select value from metadata where key='native_parser_version'").fetchone()
            if version != ('2',):
                # Reconcile an older cache without deleting retained receipts
                # or usage from history that has since been compacted away.
                db.execute("update sources set identity=NULL,offset=0,metadata='{}'")
                db.execute("insert or replace into metadata values ('native_parser_version','2')")
        self.database.chmod(0o600)

    def connect(self):
        return sqlite3.connect(self.database, timeout=5)

    def account(self):
        try:
            result = json.loads((self.directory / 'account.json').read_text())
            if (result.get('state') != 'available' or result.get('unit') not in ('AI credits', 'premium requests')
                    or number(result.get('checked_at')) is None):
                return {'state': 'unavailable'}
            for field in ('used', 'entitlement', 'remaining_percentage'):
                result[field] = number(result.get(field))
            result['stale'] = not -60 <= time.time() - result['checked_at'] <= 600
            return result
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return {'state': 'unavailable'}

    def refresh_account(self):
        with (self.directory / 'quota.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            current = self.account()
            if -60 <= time.time() - current.get('checked_at', 0) < 300:
                return
            # Failed authentication/network checks must not spawn a runtime
            # every UI refresh. Keep the last valid quota reading visibly stale.
            attempted = self.directory / 'quota-attempt'
            if attempted.exists() and time.time() - attempted.stat().st_mtime < 300:
                return
            attempted.touch(mode=0o600)
            self.query_account()

    def query_account(self):
        script = Path(__file__).parents[1] / 'copilot-pilot/account-quota.mjs'
        try:
            config_path = Path.home() / '.codex-copilot-pilot/update-config.json'
            config = json.loads(config_path.read_text()) if config_path.exists() else {}
            process = subprocess.Popen([config.get('node_bin', 'node'), str(script),
                                       '--copilot-bin', config.get('copilot_bin', 'copilot')],
                                      stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, text=True, start_new_session=True)
            try:
                output, _ = process.communicate(timeout=25)
            except subprocess.TimeoutExpired:
                # Include the SDK's CLI child in timeout cleanup.
                os.killpg(process.pid, signal.SIGKILL)
                process.communicate()
                return
            if process.returncode or len(output) > 16384:
                return
            record = json.loads(output)
            if record.get('state') != 'available':
                return
            record['checked_at'] = time.time()
            path = self.directory / 'account.json'
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps(record) + '\n');temporary.chmod(0o600);temporary.replace(path)
        except (OSError, ValueError, TypeError, AttributeError):
            pass  # Preserve an explicitly stale last-known reading, never replace it with zero.

    def register(self, rows, db):
        sources = {}
        for row in rows:
            if row.get('backend') != 'copilot' or not row.get('verified'):
                continue
            home = Path(row['target']['home'])
            try:
                with sqlite3.connect((home / 'state_5.sqlite').as_uri() + '?mode=ro', uri=True, timeout=5) as native:
                    columns = {r[1] for r in native.execute('pragma table_info(threads)')}
                    if {'created_at_ms', 'created_at'} <= columns:
                        created = 'COALESCE(created_at_ms / 1000.0,created_at)'
                    else:
                        created = 'created_at_ms / 1000.0' if 'created_at_ms' in columns else 'created_at' if 'created_at' in columns else 'NULL'
                    members = native.execute(f'''
                        WITH RECURSIVE family(id) AS (
                            SELECT ? UNION SELECT e.child_thread_id FROM thread_spawn_edges e
                            JOIN family f ON e.parent_thread_id=f.id JOIN threads t ON t.id=e.child_thread_id
                            WHERE t.source != 'cli')
                        SELECT t.id,t.rollout_path,{created} FROM family f JOIN threads t ON t.id=f.id
                    ''', (row['thread_id'],)).fetchall()
                for thread, path, born in members:
                    if not path:
                        continue
                    sources[path] = (thread, number(born))
                    db.execute('insert or ignore into families values (?,?)', (row['thread_id'], thread))
                incomplete = not members or any(number(member[2]) is None for member in members)
            except (OSError, sqlite3.Error):
                # Root metadata still provides a verified source if an older
                # native schema cannot enumerate descendants.
                thread = row['thread_id'];path = row['target']['thread']['rollout_path']
                sources[path] = (thread, None)
                db.execute('insert or ignore into families values (?,?)', (thread, thread))
                incomplete = True
            db.execute('insert or replace into metadata values (?,?)',
                       ('family_incomplete:' + row['thread_id'], str(int(incomplete))))
        for path, (thread, _) in sources.items():
            db.execute('''insert or ignore into sources(path,thread_id,identity,offset,metadata,size,unreadable)
                          values (?,?,NULL,0,'{}',0,1)''', (path, thread))
        return sources

    def read_sdk(self, db):
        with sqlite3.connect(self.sdk_database.as_uri() + '?mode=ro', uri=True, timeout=5) as source:
            records = source.execute('''SELECT id,session_id,model,created_at,input_tokens,output_tokens,
                cache_read_tokens,cache_write_tokens,reasoning_tokens,total_nano_aiu FROM assistant_usage_events''')
            for identifier, session, model, at, inp, out, cached, written, reasoning, nano in records:
                at = timestamp(at.replace(' ', 'T') + 'Z' if isinstance(at, str) and 'T' not in at else at)
                if at is None or not isinstance(model, str):
                    continue
                key = hashlib.sha256(f'{identifier}:{session}:{at}'.encode()).hexdigest()
                values = [number(v) for v in (inp, out, cached, written, reasoning, nano)]
                db.execute('insert or replace into sdk_charges values (?,?,?,?,?,?,?,?,?)',
                           (key, model[:128], at, *values))

    def read_native(self, path, thread, born, db, allowance):
        path = Path(path)
        previous = db.execute('select identity,offset,metadata from sources where path=?', (str(path),)).fetchone()
        state = json.loads(previous[2]) if previous else {}
        try:
            stat = path.stat()
            if path.suffix != '.jsonl':
                raise OSError('Compressed history requires separate reconciliation.')
            identity = f'{stat.st_dev}:{stat.st_ino}'
            offset = previous[1] if previous and previous[0] == identity and previous[1] <= stat.st_size else 0
            if not offset:
                state = {}
            start = offset
            with path.open('rb') as source:
                source.seek(offset)
                while source.tell() - start < allowance:
                    position = source.tell();line = source.readline()
                    if not line or not line.endswith(b'\n'):
                        source.seek(position);break
                    # Skip prompts, tools and opaque reasoning without decoding
                    # their JSON. Persist only content-free usage metadata.
                    if not any(marker in line for marker in (b'"turn_context"', b'"token_usage_record"', b'"token_count"')):
                        continue
                    try:
                        item = json.loads(line)
                        payload = item.get('payload', {})
                        if not isinstance(payload, dict):
                            continue
                        if item.get('type') == 'turn_context':
                            state['model'] = payload.get('model')
                            continue
                        at = timestamp(item.get('timestamp'))
                        if at is None or born is not None and at < born:
                            continue
                        canonical = item.get('type') == 'token_usage_record'
                        if canonical:
                            if payload.get('thread_id') != thread:
                                continue
                            usage = payload.get('usage', {})
                        elif item.get('type') == 'event_msg' and payload.get('type') == 'token_count':
                            if born is None:
                                continue  # Cannot distinguish inherited legacy history without a birth time.
                            info = payload.get('info') or {}
                            usage = info.get('last_token_usage') or {}
                        else:
                            continue
                        signature = [number(usage.get(key)) for key in FIELDS]
                        if any(v is None for v in signature[:3]) or not any(signature[:2]):
                            continue
                        if canonical:
                            key = hashlib.sha256((thread + ':' + payload['response_id']).encode()).hexdigest()
                            state['canonical'] = [at, signature]
                            prior = state.get('legacy')
                            if prior and prior[1] == signature and abs(at - prior[0]) <= ECHO_WINDOW:
                                db.execute('delete from native_requests where id=?', (prior[2],))
                        else:
                            totals = (info.get('total_token_usage') or {}).get('total_tokens')
                            fingerprint = [signature, totals]
                            repeat = totals is not None and state.get('counter') == fingerprint
                            state['counter'] = fingerprint
                            prior = state.get('canonical')
                            key = hashlib.sha256(f'{thread}:{at}:{signature}'.encode()).hexdigest()
                            if repeat or prior and prior[1] == signature and abs(at - prior[0]) <= ECHO_WINDOW:
                                db.execute('delete from native_requests where id=?', (key,))
                                continue
                            state['legacy'] = [at, signature, key]
                        model = state.get('model')
                        model = model[:128] if isinstance(model, str) else None
                        db.execute('insert or ignore into native_requests values (?,?,?,?,?,?,?,?,?)',
                                   (key, thread, at, model, *signature))
                    except (ValueError, TypeError, KeyError, AttributeError):
                        continue
                offset = source.tell()
            db.execute('insert or replace into sources values (?,?,?,?,?,?,0)',
                       (str(path), thread, identity, offset, json.dumps(state), stat.st_size))
            return offset - start
        except OSError:
            db.execute('insert or replace into sources values (?,?,?,?,?,?,1)',
                       (str(path), thread, None, 0, json.dumps(state), 0))
            return 0

    def refresh(self, rows, max_bytes=64 * 1024**2):
        with (self.directory / 'refresh.lock').open('a') as lock:
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                return
            with self.connect() as db:
                sources = self.register(rows, db)
                try:
                    self.read_sdk(db)
                    db.execute('insert or replace into metadata values (?,?)', ('sdk_checked_at', str(time.time())))
                except (OSError, sqlite3.Error):
                    pass
                remaining = max_bytes
                pending = []
                for path, (thread, born) in sources.items():
                    stored = db.execute('select identity,offset,unreadable from sources where path=?', (path,)).fetchone()
                    try:
                        stat = Path(path).stat()
                        identity = f'{stat.st_dev}:{stat.st_ino}'
                        db.execute('update sources set size=? where path=?', (stat.st_size, path))
                        if stored and stored == (identity, stat.st_size, 0):
                            continue
                    except OSError:
                        pass
                    pending.append((path, thread, born))
                for index, (path, thread, born) in enumerate(pending):
                    if remaining <= 0:
                        break
                    # Give every session a share of initial indexing instead of
                    # making one multi-gigabyte root starve all later rows.
                    allowance = max(1, remaining // (len(pending) - index))
                    remaining -= self.read_native(path, thread, born, db, allowance)
                # A charge must match exactly one native call, and vice versa.
                # Ambiguity is retained as missing coverage, never guessed.
                db.execute('delete from matches')
                db.execute('''INSERT INTO matches
                    WITH pairs AS (
                        SELECT n.id native_id,s.id sdk_id FROM native_requests n JOIN sdk_charges s
                        ON n.input=s.input AND n.output=s.output AND n.cached=s.cached
                        AND (n.cache_write IS NULL OR n.cache_write=s.cache_write)
                        AND (n.reasoning IS NULL OR n.reasoning=s.reasoning)
                        AND (n.model IS NULL OR n.model=s.model) AND abs(n.at-s.at)<=10),
                    single_native AS (SELECT native_id,min(sdk_id) sdk_id FROM pairs GROUP BY native_id HAVING count(*)=1),
                    single_sdk AS (SELECT sdk_id FROM pairs GROUP BY sdk_id HAVING count(*)=1)
                    SELECT n.native_id,n.sdk_id FROM single_native n JOIN single_sdk s ON s.sdk_id=n.sdk_id''')
                db.execute('insert or replace into metadata values (?,?)', ('updated_at', str(time.time())))
        self.refresh_account()

    def sessions(self):
        result = {}
        with self.connect() as db:
            checked = db.execute("select value from metadata where key='sdk_checked_at'").fetchone()
            stale = not checked or not -60 <= time.time() - float(checked[0]) <= 120
            for root, calls, reported, nano in db.execute('''
                SELECT f.root_id,count(n.id),count(s.nano),sum(s.nano)
                FROM families f LEFT JOIN native_requests n ON n.thread_id=f.thread_id
                LEFT JOIN matches m ON m.native_id=n.id LEFT JOIN sdk_charges s ON s.id=m.sdk_id
                GROUP BY f.root_id'''):
                progress = db.execute('''SELECT count(*),sum(CASE WHEN o.offset<o.size OR o.unreadable=1 THEN 1 ELSE 0 END)
                    FROM sources o JOIN families f ON f.thread_id=o.thread_id WHERE f.root_id=?''', (root,)).fetchone()
                family = db.execute('select value from metadata where key=?', ('family_incomplete:' + root,)).fetchone()
                partial = reported < calls or bool(progress[1]) or stale or family == ('1',)
                result[root] = {'nano_aiu': nano, 'reported_calls': reported, 'native_calls': calls,
                                'partial': partial, 'source': 'matched-provider-completed-calls',
                                'text': credit_text(nano, partial), 'indexing': bool(progress[1]),
                                'stale': bool(stale)}
        return result


def budget_text(account):
    if account.get('state') != 'available':
        return 'Copilot credits: unavailable (quota metadata not loaded)'
    unit = account['unit']
    used, limit = account.get('used'), account.get('entitlement')
    used_text = f'{used:,.0f}' if used is not None else 'unknown'
    limit_text = 'unlimited entitlement' if account.get('unlimited') else f'{limit:,.0f}' if limit is not None else 'budget not reported'
    text = f'Copilot seat {unit}: {used_text} / {limit_text} used'
    percentage = account.get('remaining_percentage')
    if percentage is not None:
        text += f' | {percentage:.1f}% remaining'
    if account.get('stale'):
        text += ' | STALE'
    return text
