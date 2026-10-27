import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import preserve_oci as oci


class PreservationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.temporary = self.root / 'tmp';self.temporary.mkdir()
        self.archive = self.root / 'data' / 'archive'
        (self.archive / 'receipts').mkdir(parents=True)
        self.source = self.temporary / 'sml123-oci-example';self.source.mkdir()
        layout = self.source / 'layout';layout.mkdir()
        blobs = layout / 'blobs/sha256';blobs.mkdir(parents=True)
        content = b'An immutable fixture image blob.'
        digest = hashlib.sha256(content).hexdigest()
        self.blob = blobs / digest;self.blob.write_bytes(content)
        (layout / 'oci-layout').write_text(json.dumps({'imageLayoutVersion': '1.0.0'}))
        (layout / 'index.json').write_text(json.dumps({'schemaVersion': 2, 'manifests': [
            {'digest': 'sha256:' + digest, 'size': len(content)}]}))
        self.now = time.time() + oci.MIN_AGE + 60
        for context in (patch.object(oci, 'MIN_BYTES', 1),
                        patch.object(oci, 'DATA_RESERVE', 0),
                        patch.object(oci.time, 'time', return_value=self.now)):
            context.start();self.addCleanup(context.stop)

    def preserve(self):
        snapshot, size = oci.candidate(self.source, self.now)
        oci.preserve(self.source, snapshot, size, [], self.archive)

    def receipt(self):
        path, = (self.archive / 'receipts').glob('*.json')
        return path, json.loads(path.read_text())

    def cleanup(self, dry_run=False, target=0):
        # Exercise the real copy, verification, exchange and recovery on small
        # fixtures; only the separate-volume check is simulated for portability.
        original = Path.stat
        def different_device(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == self.archive.parent:
                fields = list(info);fields[2] += 1
                return os.stat_result(fields)
            return info
        with patch.object(Path, 'stat', different_device):
            oci.cleanup(dry_run, target, [], self.temporary, self.archive)

    def test_verified_relocation_preserves_paths_bytes_and_read_only_modes(self):
        expected = self.blob.read_bytes()
        self.source.chmod(0o555)
        try:
            self.preserve()
            self.assertEqual(self.source.stat().st_mode & 0o777, 0o555)
        finally:
            self.source.chmod(0o755)  # Allow fixture cleanup through its retained path.
        self.assertTrue(self.source.is_symlink())
        self.assertEqual(self.blob.read_bytes(), expected)
        path, receipt = self.receipt()
        self.assertEqual(receipt['stage'], 'complete')
        self.assertFalse(Path(receipt['retired']).exists())

    def test_recent_partial_and_explicitly_kept_snapshots_are_ineligible(self):
        self.assertIsNone(oci.candidate(self.source, self.now - oci.MIN_AGE))
        marker = self.source / 'PRESERVE.txt';marker.write_text('keep')
        self.assertIsNone(oci.candidate(self.source, self.now));marker.unlink()
        self.blob.unlink()
        self.assertIsNone(oci.candidate(self.source, self.now))

    def test_other_owners_are_rejected(self):
        with patch.object(oci.os, 'getuid', return_value=os.getuid() + 1), self.assertRaises(ValueError):
            oci.candidate(self.source, self.now)

    def test_snapshot_opened_during_copy_is_not_redirected(self):
        with patch.object(oci, 'referenced', side_effect=[False, True]), self.assertRaisesRegex(RuntimeError, 'active'):
            self.preserve()
        self.assertFalse(self.source.is_symlink())

    def test_symlink_inside_snapshot_is_rejected_without_following_it(self):
        outside = self.root / 'outside';outside.write_bytes(self.blob.read_bytes())
        self.blob.unlink();self.blob.symlink_to(outside)
        with self.assertRaises(ValueError):
            oci.candidate(self.source, self.now)
        self.assertEqual(outside.read_bytes(), b'An immutable fixture image blob.')

    def test_live_file_and_container_mounts_prevent_preservation(self):
        with self.blob.open('rb'):
            self.assertTrue(oci.referenced(self.source, []))
        self.assertTrue(oci.referenced(self.source, [self.temporary]))
        with patch.object(oci, 'referenced', return_value=True), self.assertRaisesRegex(RuntimeError, 'active'):
            self.preserve()
        self.assertFalse(self.source.is_symlink())
        self.assertEqual(list((self.archive / 'receipts').iterdir()), [])

    def test_data_reserve_and_dry_run_leave_source_and_archives_untouched(self):
        with patch.object(oci, 'DATA_RESERVE', 10**30), self.assertRaisesRegex(RuntimeError, 'reserve'):
            self.preserve()
        with patch.object(oci.subprocess, 'run') as run:
            self.cleanup(dry_run=True)
            run.assert_not_called()
        self.assertFalse(self.source.is_symlink())
        self.assertEqual(list((self.archive / 'receipts').iterdir()), [])

    def test_copy_timeout_has_recoverable_intent_before_any_path_switch(self):
        with patch.object(oci.subprocess, 'run', side_effect=subprocess.TimeoutExpired('rsync', 1)):
            with self.assertRaises(subprocess.TimeoutExpired):
                self.preserve()
        _, record = self.receipt()
        self.assertEqual(record['stage'], 'copying')
        self.assertFalse(self.source.is_symlink())
        # Even a now-healthy root must finish its interrupted transaction.
        self.cleanup(target=0)
        self.assertTrue(self.source.is_symlink())
        self.assertEqual(self.receipt()[1]['stage'], 'complete')

    def test_interruption_after_exchange_recovers_from_preexisting_verified_intent(self):
        original = oci.save
        def fail_after_exchange(path, record):
            if record['stage'] == 'redirected':
                raise OSError('interrupted receipt update')
            return original(path, record)
        with patch.object(oci, 'save', side_effect=fail_after_exchange), self.assertRaises(OSError):
            self.preserve()
        _, record = self.receipt()
        self.assertEqual(record['stage'], 'verified')
        self.assertTrue(self.source.is_symlink())
        self.assertTrue(Path(record['retired']).is_dir())
        self.cleanup()
        self.assertFalse(Path(record['retired']).exists())
        self.assertEqual(self.receipt()[1]['stage'], 'complete')

    def test_partial_duplicate_removal_can_be_resumed_without_dropping_preserved_files(self):
        expected = self.blob.read_bytes()
        def partial_remove(retired):
            (retired / 'layout/oci-layout').unlink()
            raise OSError('interrupted deletion')
        with patch.object(oci.shutil, 'rmtree', side_effect=partial_remove), self.assertRaises(OSError):
            self.preserve()
        self.cleanup()
        self.assertEqual(self.blob.read_bytes(), expected)
        self.assertTrue((self.source / 'layout/oci-layout').exists())
        self.assertEqual(self.receipt()[1]['stage'], 'complete')

    def test_source_change_during_verification_never_switches_the_original_path(self):
        original = oci.verify
        def mutate(source, destination, **kwargs):
            original(source, destination, **kwargs)
            self.blob.write_bytes(b'new active data')
        with patch.object(oci, 'verify', side_effect=mutate), self.assertRaisesRegex(RuntimeError, 'changed'):
            self.preserve()
        self.assertFalse(self.source.is_symlink())
        self.assertEqual(self.blob.read_bytes(), b'new active data')

    def test_incorrect_copy_and_replaced_source_are_never_removed(self):
        with patch.object(oci, 'verify', side_effect=RuntimeError('copy differs')), self.assertRaises(RuntimeError):
            self.preserve()
        self.assertFalse(self.source.is_symlink())
        receipt, record = self.receipt()
        other = self.temporary / 'other';self.source.rename(other);self.source.mkdir()
        with self.assertRaises(RuntimeError):
            oci.finish(receipt, record, [])
        self.assertTrue(other.is_dir())


if __name__ == '__main__':
    unittest.main()
