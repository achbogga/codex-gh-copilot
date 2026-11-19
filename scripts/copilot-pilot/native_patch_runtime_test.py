import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import native_patch_runtime as native
import runtime_update as runtime


class PatchedNativeRuntimeTests(unittest.TestCase):
    def test_stock_runtime_does_not_build_without_explicit_configuration(self):
        stock = Path('/runtime/bin/codex')
        with patch.object(native.subprocess, 'run') as run:
            self.assertEqual(native.install_patched({}, stock, '1.2.3', Path('/runtimes')), (stock, None))
            run.assert_not_called()

    def test_patch_recipe_rejects_missing_or_escaped_files_and_changes_with_content(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            patches = repo / 'patches'
            patches.mkdir(parents=True)
            for path in ('patches', '../outside'):
                with self.assertRaises(ValueError):
                    native.patch_recipe(repo, path)
            source = patches / 'keyboard.patch'
            source.write_text('first patch')
            first = native.patch_recipe(repo, 'patches')[2]
            source.write_text('changed patch')
            self.assertNotEqual(first, native.patch_recipe(repo, 'patches')[2])
            source.unlink()
            outside = root / 'outside.patch'
            outside.write_text('outside')
            source.symlink_to(outside)
            with self.assertRaises(ValueError):
                native.patch_recipe(repo, 'patches')

    def test_cached_runtime_verifies_both_executables_and_the_recipe_without_rebuilding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            repo = root / 'repo'
            patches = repo / 'patches'
            patches.mkdir(parents=True)
            (patches / 'keyboard.patch').write_text('patch')
            _, recipe, identifier = native.patch_recipe(repo, 'patches')
            destination = root / 'runtimes/codex' / ('1.2.3-patched-' + identifier[:16])
            binary = destination / 'bin/codex'
            binary.parent.mkdir(parents=True)
            binary.write_text('native executable')
            host = binary.with_name('codex-code-mode-host')
            host.write_text('native companion')
            manifest = {'version': '1.2.3', 'patches': recipe, 'binary_sha256': native.digest(binary),
                        'code_mode_host_sha256': native.digest(host)}
            (destination / 'native-patches.json').write_text(json.dumps(manifest))
            config = {'repo': str(repo), 'native_patch_dir': 'patches'}
            with patch.object(native.subprocess, 'run') as run:
                self.assertEqual(native.install_patched(config, Path('/stock/bin/codex'), '1.2.3', root / 'runtimes'),
                                 (binary, manifest))
                run.assert_not_called()
            for executable in (binary, host):
                original = executable.read_bytes()
                executable.write_text('altered executable')
                with self.assertRaisesRegex(ValueError, 'failed verification'):
                    native.verify_bundle(destination, '1.2.3', recipe)
                executable.write_bytes(original)
            with self.assertRaisesRegex(ValueError, 'failed verification'):
                native.verify_bundle(destination, '1.2.4', recipe)

    def test_launcher_can_adopt_only_an_explicit_previous_native_repair(self):
        text = '#!/bin/sh\nexec /node /host-run.mjs --codex-bin /custom/bin/codex "$@"\n'
        config = {'codex_bin': '/stock/bin/codex'}
        with self.assertRaisesRegex(ValueError, 'differs from the managed'):
            runtime.replace_launcher_runtime(text, config, Path('/new/bin/codex'), Path('/node'), Path('/new/node'))
        config['codex_previous_bins'] = ['/custom/bin/codex']
        result = runtime.replace_launcher_runtime(text, config, Path('/new/bin/codex'), Path('/node'), Path('/new/node'))
        self.assertEqual(result, text.replace('/custom/bin/codex', '/new/bin/codex').replace('exec /node ', 'exec /new/node '))
        with self.assertRaisesRegex(ValueError, 'differs from the managed'):
            runtime.replace_launcher_runtime(text.replace('/custom/bin/codex', '/custom/bin/codex-other'), config,
                                             Path('/new/bin/codex'), Path('/node'), Path('/new/node'))
        for previous in ('/custom/bin/codex', ['relative/path']):
            with self.assertRaisesRegex(ValueError, 'absolute runtime paths'):
                runtime.replace_launcher_runtime(text, {**config, 'codex_previous_bins': previous},
                                                 Path('/new/bin/codex'), Path('/node'), Path('/new/node'))


if __name__ == '__main__':
    unittest.main()
