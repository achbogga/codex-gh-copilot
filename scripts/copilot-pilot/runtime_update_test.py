import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('runtime_update', Path(__file__).with_name('runtime_update.py'))
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class RuntimeUpdateTests(unittest.TestCase):
    def test_managed_launchers_are_deduplicated_and_cannot_escape_home(self):
        with tempfile.TemporaryDirectory() as directory:
            home = Path(directory) / 'home'
            home.mkdir()
            entry = home / 'bin/codex'
            config = {'codex_entry': str(entry), 'codex_entries': [str(entry)]}
            self.assertEqual(runtime.codex_entries(config, home), [entry])
            (home / 'escape').symlink_to(Path(directory), target_is_directory=True)
            for extra in ('not-a-list', [str(home / 'escape/codex')], ['/usr/bin/codex'], ['relative/codex']):
                with self.subTest(extra=extra), self.assertRaises(ValueError):
                    runtime.codex_entries({**config, 'codex_entries': extra}, home)

    def test_each_registered_launcher_updates_without_changing_the_old_executable(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old, new = root / 'old-runtime', root / 'new-runtime'
            old.write_text('old executable')
            new.write_text('new executable')
            entries = [root / 'node20-codex', root / 'node24-codex']
            for entry in entries:
                entry.symlink_to(old)
            runtime.point_codex_entries(entries, new, root)
            self.assertTrue(all(entry.resolve() == new for entry in entries))
            self.assertEqual(old.read_text(), 'old executable')
            backup = json.loads((root / 'codex-entries-before.json').read_text())
            self.assertEqual(backup, [{'path': str(entry), 'link': str(old)} for entry in entries])

    def test_cached_download_is_verified_and_bad_bytes_cannot_install(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'runtime.tgz'
            path.write_bytes(b'verified bytes')
            expected = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertEqual(runtime.download('unused', path, 'sha256', expected), path)
            path.write_bytes(b'altered bytes')
            with self.assertRaises(ValueError):
                runtime.download('unused', path, 'sha256', expected)

    def test_archive_escape_is_rejected_before_publishing_installation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive = root / 'unsafe.tar.gz'
            with tarfile.open(archive, 'w:gz') as output:
                entry = tarfile.TarInfo('../escaped')
                entry.size = 4
                output.addfile(entry, io.BytesIO(b'evil'))
            with self.assertRaises(tarfile.FilterError):
                runtime.unpack(archive, root / 'installed')
            self.assertFalse((root / 'installed').exists())
            self.assertFalse((root / 'escaped').exists())

    def test_prerelease_or_malformed_versions_are_never_installed(self):
        for value in [b'{"draft":true}', b'{"prerelease":true}', b'{"tag_name":"v1.2.3-beta"}']:
            with patch.object(runtime, 'get', return_value=value):
                with self.assertRaises(ValueError):
                    runtime.stable_release('official/repo')

    def test_atomic_pointer_change_keeps_old_executable_untouched(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old, new, entry = root / 'old', root / 'new', root / 'codex'
            old.write_text('old executable')
            new.write_text('new executable')
            entry.symlink_to(old)
            runtime.atomic_link(entry, new)
            self.assertEqual(entry.resolve(), new)
            self.assertEqual(old.read_text(), 'old executable')


if __name__ == '__main__':
    unittest.main()
