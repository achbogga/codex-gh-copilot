import unittest

from install_cache_cleanup import remove_cleanup_blocks


class ScheduleTests(unittest.TestCase):
    def test_only_managed_cleanup_blocks_are_removed(self):
        unrelated = '# recovery job\n* * * * * /home/user/session-watch\n'
        managed = ('# BEGIN managed daily developer cache cleanup\n47 3 * * * cleanup\n'
                   '# END managed daily developer cache cleanup\n')
        pressure = ('# BEGIN managed root disk pressure check\n*/5 * * * * cleanup --pressure\n'
                    '# END managed root disk pressure check\n')
        self.assertEqual(remove_cleanup_blocks(unrelated + managed + pressure), unrelated)
        self.assertEqual(remove_cleanup_blocks(unrelated), unrelated)

    def test_incomplete_block_does_not_drop_unrelated_jobs(self):
        with self.assertRaises(ValueError):
            remove_cleanup_blocks('# BEGIN managed root disk pressure check\n* * * * * session-watch\n')


if __name__ == '__main__':
    unittest.main()
