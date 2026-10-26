import datetime
import json
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch

from credits import Billing, budget_text, credit_text, timestamp


class CreditsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sdk = self.root / 'sdk.sqlite'
        with sqlite3.connect(self.sdk) as db:
            db.execute('''create table assistant_usage_events(id integer primary key, session_id text,
                model text,created_at text,input_tokens integer,output_tokens integer,cache_read_tokens integer,
                cache_write_tokens integer,reasoning_tokens integer,total_nano_aiu integer)''')
        with sqlite3.connect(self.root / 'state_5.sqlite') as db:
            db.executescript('''create table threads(id text primary key,rollout_path text,source text,created_at_ms integer);
                create table thread_spawn_edges(parent_thread_id text,child_thread_id text primary key,status text);''')
        self.billing = Billing(self.root / 'billing', self.sdk)
        self.addCleanup(self.billing.database.unlink, missing_ok=True)
        self.at = int(time.time()) - 100
        self.row = self.thread('root')
        self.usage = dict(zip(('input_tokens', 'output_tokens', 'cached_input_tokens',
                              'cache_write_input_tokens', 'reasoning_output_tokens'), (11, 7, 3, 0, 0)))

    def iso(self, at):
        return datetime.datetime.fromtimestamp(at, datetime.timezone.utc).isoformat()

    def thread(self, name, parent=None, source='cli', born=None):
        path = self.root / (name + '.jsonl')
        path.write_text(json.dumps({'type': 'turn_context', 'payload': {'model': 'model'}}) + '\n')
        with sqlite3.connect(self.root / 'state_5.sqlite') as db:
            db.execute('insert into threads values (?,?,?,?)',
                       (name, str(path), source, int((born if born is not None else self.at - 10) * 1000)))
            if parent:
                db.execute('insert into thread_spawn_edges values (?,?,?)', (parent, name, 'complete'))
        return {'verified': True, 'backend': 'copilot', 'thread_id': name,
                'target': {'home': str(self.root), 'thread': {'rollout_path': str(path)}}}

    def native(self, name='root', *, at=None, usage=None, canonical=True, response='opaque-private', total=18):
        at = self.at if at is None else at
        usage = self.usage if usage is None else usage
        if canonical:
            item = {'type': 'token_usage_record', 'timestamp': self.iso(at),
                    'payload': {'thread_id': name, 'response_id': response, 'usage': usage}}
        else:
            item = {'type': 'event_msg', 'timestamp': self.iso(at), 'payload': {'type': 'token_count',
                    'info': {'last_token_usage': usage, 'total_token_usage': {'total_tokens': total}}}}
        return item

    def append(self, name, *items):
        with (self.root / (name + '.jsonl')).open('a') as output:
            for item in items:
                output.write(json.dumps(item) + '\n')

    def sdk_charge(self, *, at=None, usage=None, nano=1234567890, model='model'):
        usage = self.usage if usage is None else usage
        values = [usage.get(key) for key in self.usage]
        with sqlite3.connect(self.sdk) as db:
            db.execute('insert into assistant_usage_events values (NULL,?,?,?,?,?,?,?,?,?)',
                       ('sdk-session', model, self.iso(self.at + .02 if at is None else at), *values, nano))

    def refresh(self, rows=None, **kwargs):
        with patch.object(self.billing, 'refresh_account'):
            self.billing.refresh(rows or [self.row], **kwargs)
        return self.billing.sessions()['root']

    def test_exact_reported_integer_charge_no_opaque_content_in_cache(self):
        self.append('root', self.native())
        self.sdk_charge()
        value = self.refresh()
        self.assertEqual(value['nano_aiu'], 1234567890)
        self.assertEqual(value['text'], '1.23')
        self.assertEqual(value['reported_calls'], 1)
        self.assertFalse(value['partial'])
        self.assertNotIn(b'opaque-private', self.billing.database.read_bytes())
        self.assertEqual(self.refresh()['nano_aiu'], value['nano_aiu'])

    def test_zero_is_real_only_when_reported_and_unknown_charge_is_not_zero(self):
        self.append('root', self.native())
        self.sdk_charge(nano=0)
        self.assertEqual(self.refresh()['text'], '0.00')
        with sqlite3.connect(self.sdk) as db:
            db.execute('update assistant_usage_events set total_nano_aiu=NULL')
        value = self.refresh()
        self.assertIsNone(value['nano_aiu'])
        self.assertEqual(value['text'], '-')
        self.assertTrue(value['partial'])

    def test_children_included_but_cli_forks_and_their_agents_excluded(self):
        self.thread('agent', parent='root', source='subagent')
        self.thread('grandchild', parent='agent', source='subagent')
        self.thread('fork', parent='root')
        self.thread('fork-agent', parent='fork', source='subagent')
        for offset, name in enumerate(('root', 'agent', 'grandchild', 'fork', 'fork-agent')):
            at = self.at + offset * 30
            self.append(name, self.native(name, at=at))
            self.sdk_charge(at=at + .02, nano=1_000_000_000)
        self.assertEqual(self.refresh()['nano_aiu'], 3_000_000_000)
        with self.billing.connect() as db:
            self.assertEqual(db.execute('select count(*) from families').fetchone()[0], 3)

    def test_inherited_canonical_records_and_legacy_records_before_birth_are_excluded(self):
        self.append('root', self.native('parent'), self.native(at=self.at - 50, canonical=False), self.native())
        self.sdk_charge()
        self.assertEqual(self.refresh()['native_calls'], 1)

    def test_old_schema_does_not_guess_inherited_legacy_history_or_complete_family_coverage(self):
        with sqlite3.connect(self.root / 'state_5.sqlite') as db:
            db.execute('drop table thread_spawn_edges')
        self.append('root', self.native(canonical=False, at=self.at - 30), self.native())
        self.sdk_charge()
        value = self.refresh()
        self.assertEqual(value['reported_calls'], 1)
        self.assertEqual(value['native_calls'], 1)
        self.assertTrue(value['partial'])

    def test_canonical_and_legacy_pair_deduplicate_in_both_orders_and_across_refresh(self):
        for canonical_first in (True, False):
            with self.subTest(canonical_first=canonical_first):
                with self.billing.connect() as db:
                    db.execute('delete from native_requests');db.execute('delete from sources')
                path = self.root / 'root.jsonl'
                path.write_text('')
                self.append('root', self.native(canonical=canonical_first))
                self.refresh()
                self.append('root', self.native(canonical=not canonical_first, at=self.at + 8))
                self.append('root', self.native(canonical=False, at=self.at + 20))  # repeated counter after error
                value = self.refresh()
                self.assertEqual(value['native_calls'], 1)

    def test_distinct_canonical_responses_with_identical_counts_are_not_silently_deduplicated(self):
        self.append('root', self.native(), self.native(at=self.at + 5, response='second-response'))
        self.sdk_charge();self.sdk_charge(at=self.at + 5.02)
        value = self.refresh()
        self.assertEqual(value['native_calls'], 2)
        self.assertEqual(value['reported_calls'], 0)  # Same-count receipts remain ambiguous.
        self.assertTrue(value['partial'])

    def test_legacy_only_accounting_and_repeated_counter_events(self):
        self.append('root', self.native(canonical=False), self.native(canonical=False, at=self.at + 3))
        self.sdk_charge()
        self.assertEqual(self.refresh()['reported_calls'], 1)

    def test_ambiguous_or_mismatched_receipts_are_never_assigned(self):
        self.append('root', self.native())
        self.sdk_charge();self.sdk_charge(at=self.at + .2)
        value = self.refresh()
        self.assertEqual(value['reported_calls'], 0)
        self.assertTrue(value['partial'])
        with sqlite3.connect(self.sdk) as db:
            db.execute('delete from assistant_usage_events')
        # New native call competes with the same receipt already in our cache.
        self.append('root', self.native(at=self.at + 1, response='second-response'))
        self.assertEqual(self.refresh()['reported_calls'], 0)

    def test_receipt_requires_model_and_all_recorded_token_counts_and_ten_second_window(self):
        self.append('root', self.native())
        for opts in ({'model': 'other'}, {'at': self.at + 11},
                     {'usage': {**self.usage, 'cache_write_input_tokens': 1}},
                     {'usage': {**self.usage, 'reasoning_output_tokens': 1}}):
            self.sdk_charge(**opts)
        self.assertEqual(self.refresh()['reported_calls'], 0)

    def test_unfinished_tail_append_replacement_and_truncation_keep_lifetime_totals(self):
        self.sdk_charge()
        path = self.root / 'root.jsonl'
        with path.open('a') as output:
            line = json.dumps(self.native())
            output.write(line[:len(line)//2])
        self.assertEqual(self.refresh()['native_calls'], 0)
        with path.open('a') as output:
            output.write(line[len(line)//2:] + '\n')
        self.assertEqual(self.refresh()['reported_calls'], 1)
        replacement = path.with_suffix('.replacement')
        replacement.write_text(json.dumps(self.native()) + '\n');replacement.replace(path)
        self.assertEqual(self.refresh()['reported_calls'], 1)
        path.write_text('')
        self.assertEqual(self.refresh()['reported_calls'], 1)

    def test_budgeted_scan_marks_unvisited_sources_and_progress_then_completes(self):
        self.thread('agent', parent='root', source='subagent')
        self.append('root', self.native())
        self.append('agent', self.native('agent', at=self.at + 30))
        self.sdk_charge();self.sdk_charge(at=self.at + 30)
        self.assertTrue(self.refresh(max_bytes=1)['indexing'])
        value = self.refresh()
        self.assertFalse(value['indexing'])
        self.assertEqual(value['reported_calls'], 2)
        self.assertFalse(value['text'].endswith('+'))

    def test_missing_sdk_history_keeps_cached_receipts_visibly_stale(self):
        self.append('root', self.native());self.sdk_charge();self.refresh()
        self.sdk.unlink()
        with self.billing.connect() as db:
            db.execute("update metadata set value='0' where key='sdk_checked_at'")
        value = self.refresh()
        self.assertEqual(value['nano_aiu'], 1234567890)
        self.assertTrue(value['stale'])
        self.assertTrue(value['partial'])

    def test_unreadable_source_and_bad_records_are_unknown_without_disrupting_other_usage(self):
        agent = self.thread('agent', parent='root', source='subagent')
        Path(agent['target']['thread']['rollout_path']).unlink()
        self.append('root', {'type': 'token_usage_record', 'payload': {}},
                    self.native(usage={**self.usage, 'input_tokens': -1}), self.native())
        self.sdk_charge()
        value = self.refresh()
        self.assertEqual(value['reported_calls'], 1)
        self.assertTrue(value['partial'])

    def test_unknown_stale_legacy_and_unlimited_account_format(self):
        self.assertIn('unavailable', budget_text({}))
        base = {'state': 'available', 'unit': 'AI credits', 'used': 0, 'entitlement': 700000,
                'remaining_percentage': 100, 'checked_at': time.time()}
        path = self.billing.directory / 'account.json'
        path.write_text(json.dumps(base))
        self.assertFalse(self.billing.account()['stale'])
        base['checked_at'] = time.time() - 1000;path.write_text(json.dumps(base))
        self.assertIn('STALE', budget_text(self.billing.account()))
        self.assertIn('0 / 700,000', budget_text(base))
        self.assertIn('unlimited entitlement', budget_text({**base, 'unlimited': True}))
        self.assertIn('budget not reported', budget_text({**base, 'entitlement': None}))
        self.assertIn('premium requests', budget_text({**base, 'unit': 'premium requests'}))
        for corrupt in ({'state': 'available', 'checked_at': 1}, [], {'checked_at': 'yesterday'}):
            path.write_text(json.dumps(corrupt))
            self.assertEqual(self.billing.account()['state'], 'unavailable')

    def test_quota_refresh_is_cached_and_a_failure_preserves_stale_reading(self):
        path = self.billing.directory / 'account.json'
        original = {'state': 'available', 'unit': 'AI credits', 'used': 10,
                    'entitlement': 20, 'checked_at': time.time()}
        path.write_text(json.dumps(original))
        with patch.object(self.billing, 'query_account') as query:
            self.billing.refresh_account();query.assert_not_called()
            original['checked_at'] = 0;path.write_text(json.dumps(original))
            self.billing.refresh_account();self.billing.refresh_account()
            query.assert_called_once()
        self.assertEqual(self.billing.account()['used'], 10)
        self.assertTrue(self.billing.account()['stale'])

    def test_slow_index_writer_does_not_block_ui_readers(self):
        self.append('root', self.native());self.sdk_charge();self.refresh()
        with self.billing.connect() as writer:
            writer.execute("update metadata set value='0' where key='updated_at'")
            self.assertEqual(self.billing.sessions()['root']['reported_calls'], 1)

    def test_exact_decimal_formatting_small_costs_and_invalid_timestamps(self):
        self.assertEqual(credit_text(None), '-')
        self.assertEqual(credit_text(1), '<0.01')
        self.assertEqual(credit_text(1234567890123456789, True), '1,234,567,890.12+')
        for value in (None, '', '2026-01-01', 'not-a-date'):
            self.assertIsNone(timestamp(value))


if __name__ == '__main__':
    unittest.main()
