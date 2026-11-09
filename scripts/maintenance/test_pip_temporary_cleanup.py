from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import dev_cache_cleanup as cleanup


class PipTemporaryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.old = self.root / 'pip-unpack-old';self.old.mkdir()
        self.wheel = self.old / 'package.whl';self.wheel.write_bytes(b'cache')
        self.future = time.time() + 8 * 86400
        self.docker = patch.object(cleanup, 'docker_read', return_value='')
        self.docker.start();self.addCleanup(self.docker.stop)

    def test_recent_and_unrecognized_directories_are_retained(self):
        unknown = self.root / 'experiment-evidence';unknown.mkdir()
        cleanup.clean_pip_temporary(False, self.root)
        self.assertTrue(self.wheel.exists())
        cleanup.clean_pip_temporary(False, self.root, self.future)
        self.assertFalse(self.old.exists())
        self.assertTrue(unknown.exists())

    def test_open_files_and_symlinks_are_retained(self):
        with self.wheel.open('rb'):
            cleanup.clean_pip_temporary(False, self.root, self.future)
        self.assertTrue(self.wheel.exists())
        (self.old / 'external').symlink_to(self.root / 'outside')
        cleanup.clean_pip_temporary(False, self.root, self.future)
        self.assertTrue(self.wheel.exists())

    def test_dry_run_does_not_delete(self):
        cleanup.clean_pip_temporary(True, self.root, self.future)
        self.assertTrue(self.wheel.exists())


if __name__ == '__main__':
    unittest.main()
