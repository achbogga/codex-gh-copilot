from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import notify_cleanup_failure as notify


class NotificationTests(unittest.TestCase):
    def test_notifications_are_rate_limited_even_without_a_desktop(self):
        with tempfile.TemporaryDirectory() as directory, \
             patch.object(notify.Path, 'home', return_value=Path(directory)), \
             patch.object(notify.time, 'time', side_effect=[10000, 10030, 13601]), \
             patch.object(notify.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)) as run:
            notify.main()
            notify.main()
            self.assertEqual(run.call_count, 1)
            notify.main()
            self.assertEqual(run.call_count, 2)
            self.assertTrue((Path(directory) / '.local/state/dev-cache-cleanup/last-notification.json').exists())


if __name__ == '__main__':
    unittest.main()
