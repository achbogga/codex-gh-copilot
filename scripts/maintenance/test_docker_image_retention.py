import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch

import docker_image_retention as retention


class ImageRetentionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.image = {'Id': 'sha256:' + 'a' * 64, 'RepoTags': ['local:keep'],
                      'RepoDigests': [], 'Size': 128, 'Created': '2020-01-01T00:00:00Z'}

    def archive(self, layer=b'layer bytes', expected_layer=None):
        digest = hashlib.sha256(expected_layer if expected_layer is not None else layer).hexdigest()
        config = json.dumps({'rootfs': {'diff_ids': ['sha256:' + digest]}}).encode()
        identity = 'sha256:' + hashlib.sha256(config).hexdigest()
        content = {'config.json': config, 'layer.tar': layer,
                   'manifest.json': json.dumps([{'Config': 'config.json', 'Layers': ['layer.tar']}]).encode()}
        path = self.root / 'image.tar'
        with tarfile.open(path, 'w') as archive:
            for name, value in content.items():
                info = tarfile.TarInfo(name);info.size = len(value)
                archive.addfile(info, io.BytesIO(value))
        return path, identity

    def test_archive_verifies_identity_and_layer_bytes(self):
        path, identity = self.archive()
        retention.verify_archive(path, identity)
        with self.assertRaisesRegex(ValueError, 'config'):
            retention.verify_archive(path, self.image['Id'])
        path, identity = self.archive(layer=b'corrupted', expected_layer=b'original')
        with self.assertRaisesRegex(ValueError, 'layer'):
            retention.verify_archive(path, identity)

    def test_fixed_build_date_does_not_make_new_cache_eligible(self):
        now = 1800000000
        first = retention.observations([self.image], set(), {}, now)
        self.assertEqual(first[self.image['Id']]['unused_since'], now)
        second = retention.observations([self.image], set(), first, now + 86400)
        self.assertEqual(second[self.image['Id']]['unused_since'], now)
        gap = retention.observations([self.image], set(), first, now + 3 * 86400)
        self.assertEqual(gap[self.image['Id']]['unused_since'], now + 3 * 86400)
        self.assertEqual(retention.observations([self.image], {self.image['Id']}, first, now), {})
        multiple = dict(self.image, RepoTags=['one:tag', 'another:tag'])
        self.assertEqual(retention.observations([multiple], set(), first, now), {})
        changed = dict(self.image, RepoTags=['new:tag'])
        reset = retention.observations([changed], set(), first, now + 86400)
        self.assertEqual(reset[self.image['Id']]['unused_since'], now + 86400)

    def test_registry_proof_must_match_local_image_and_outage_keeps_it(self):
        image = dict(self.image, RepoDigests=['registry/image@sha256:manifest'])
        with patch.object(retention, 'read', return_value=json.dumps({'config': {'digest': image['Id']}})):
            source = retention.recovery_source(image, self.root)
        self.assertEqual(source, {'kind': 'registry', 'reference': image['RepoDigests'][0]})
        with patch.object(retention, 'read', return_value=json.dumps({'config': {'digest': 'different'}})):
            with self.assertRaisesRegex(RuntimeError, 'keeping image'):
                retention.recovery_source(image, self.root)
        with patch.object(retention, 'read', side_effect=subprocess.CalledProcessError(1, 'docker')):
            with self.assertRaises(RuntimeError):
                retention.recovery_source(image, self.root)

    def test_image_removal_has_durable_recovery_receipt_and_never_forces(self):
        def remove(command, **kwargs):
            receipt = json.loads((self.root / ('a' * 64 + '.json')).read_text())
            self.assertEqual(receipt['status'], 'verified')
            self.assertEqual(command[-3:], ['image', 'rm', self.image['Id']])
            self.assertNotIn('--force', command)
            return subprocess.CompletedProcess(command, 0, '', '')
        with patch.object(retention, 'recovery_source', return_value={'kind': 'registry', 'reference': 'registry@sha256:digest'}), \
             patch.object(retention, 'inventory', return_value=([self.image], set())), \
             patch.object(retention.subprocess, 'run', side_effect=remove):
            record = retention.reclaim(self.image, self.root)
        self.assertEqual(record['status'], 'removed')

    def test_multi_arch_registry_reference_selects_matching_config(self):
        image = dict(self.image, RepoDigests=['registry/image@sha256:index'], Os='linux', Architecture='amd64')
        child = 'sha256:' + 'b' * 64
        index = {'manifests': [{'digest': child, 'platform': {'os': 'linux', 'architecture': 'amd64'}}]}
        with patch.object(retention, 'read', side_effect=[json.dumps(index), json.dumps({'config': {'digest': image['Id']}})]):
            source = retention.recovery_source(image, self.root)
        self.assertEqual(source['reference'], 'registry/image@' + child)

    def test_container_or_tag_added_during_preservation_prevents_removal(self):
        scenarios = [([self.image], {self.image['Id']}),
                     ([dict(self.image, RepoTags=['another:tag'])], set())]
        for inventory in scenarios:
            with self.subTest(inventory=inventory), \
                 patch.object(retention, 'recovery_source', return_value={'kind': 'archive', 'path': 'safe.tar'}), \
                 patch.object(retention, 'inventory', return_value=inventory), \
                 patch.object(retention.subprocess, 'run') as remove:
                record = retention.reclaim(self.image, self.root)
            remove.assert_not_called()
            self.assertEqual(record['status'], 'kept-changed-or-in-use')

    def test_failed_preservation_never_removes_image(self):
        with patch.object(retention, 'recovery_source', side_effect=ValueError('bad archive')), \
             patch.object(retention.subprocess, 'run') as remove, self.assertRaises(ValueError):
            retention.reclaim(self.image, self.root)
        remove.assert_not_called()

    def test_dry_run_and_observation_grace_period_do_not_reclaim(self):
        usage = type('Usage', (), {'free': 0})()
        with patch.object(retention, 'inventory', return_value=([self.image], set())), \
             patch.object(retention, 'storage_on_root', return_value=True), \
             patch.object(retention.shutil, 'disk_usage', return_value=usage), \
             patch.object(retention, 'reclaim') as reclaim:
            retention.sweep(self.root, False, 1)
            reclaim.assert_not_called()
            original = (self.root / 'unused-images.json').read_bytes()
            retention.sweep(self.root, True, 1, reclaim_now=True)
            reclaim.assert_not_called()
            self.assertEqual((self.root / 'unused-images.json').read_bytes(), original)

    def test_export_requires_root_staging_headroom(self):
        original = Path.stat
        def separate_device(path, *args, **kwargs):
            info = original(path, *args, **kwargs)
            if path == self.root:
                values = list(info);values[2] += 1
                return os.stat_result(values)
            return info
        def usage(path):
            return type('Usage', (), {'free': 10**15 if Path(path) == self.root else 1})()
        with patch.object(Path, 'stat', separate_device), \
             patch.object(retention.shutil, 'disk_usage', side_effect=usage), \
             patch.object(retention.subprocess, 'run') as run, self.assertRaisesRegex(RuntimeError, 'headroom'):
            retention.recovery_source(self.image, self.root)
        run.assert_not_called()

    def test_pressure_cleanup_does_not_prune_images_on_another_disk(self):
        with patch.object(retention, 'inventory', return_value=([self.image], set())), \
             patch.object(retention, 'storage_on_root', return_value=False), \
             patch.object(retention, 'reclaim') as reclaim:
            retention.sweep(self.root, False, 1, reclaim_now=True)
        reclaim.assert_not_called()

    def test_restore_refuses_to_overwrite_an_existing_changed_tag(self):
        receipt = self.root / 'receipt.json'
        receipt.write_text(json.dumps({'image_id': self.image['Id'], 'tags': ['local:keep'],
                                       'recovery': {'kind': 'registry', 'reference': 'registry@sha256:id'}}))
        changed = dict(self.image, Id='sha256:' + 'b' * 64)
        with patch.object(retention, 'inventory', return_value=([changed], set())), \
             patch.object(retention.subprocess, 'run') as run, self.assertRaisesRegex(RuntimeError, 'another image'):
            retention.restore(receipt)
        run.assert_not_called()


if __name__ == '__main__':
    unittest.main()
