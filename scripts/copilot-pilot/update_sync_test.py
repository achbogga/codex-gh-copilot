from pathlib import Path
import subprocess
import tempfile
import unittest

from update_check import sync_upstream


class UpdateSyncTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="copilot-sync-test-")
        self.addCleanup(self.temporary.cleanup)
        self.repo = Path(self.temporary.name)
        self.git("init", "-q", "-b", "main")
        self.git("config", "user.name", "Update test")
        self.git("config", "user.email", "update-test@example.invalid")
        self.git("config", "commit.gpgsign", "false")
        (self.repo / "shared").write_text("base")
        self.git("add", ".")
        self.git("commit", "-qm", "base")
        self.git("branch", "incoming")
        (self.repo / "adapter").write_text("keep fork adapter")
        self.git("add", ".")
        self.git("commit", "-qm", "fork")
        self.local = self.git("rev-parse", "HEAD")
        self.git("checkout", "-q", "incoming")
        (self.repo / "upstream-feature").write_text("new upstream feature")
        self.git("add", ".")
        self.git("commit", "-qm", "upstream")
        self.upstream = self.git("rev-parse", "HEAD")
        self.git("update-ref", "refs/remotes/upstream/main", self.upstream)
        self.git("checkout", "-q", "main")

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.repo), *args], text=True, stderr=subprocess.PIPE
        ).strip()

    def test_merge_preserves_fork_and_adopts_upstream_then_becomes_noop(self):
        self.assertTrue(sync_upstream(self.repo))
        self.assertEqual(
            self.git("show", "-s", "--format=%P"), f"{self.local} {self.upstream}"
        )
        self.assertEqual((self.repo / "adapter").read_text(), "keep fork adapter")
        self.assertEqual(
            (self.repo / "upstream-feature").read_text(), "new upstream feature"
        )
        self.assertEqual(self.git("status", "--porcelain"), "")
        self.assertFalse(sync_upstream(self.repo))

    def test_dirty_checkout_is_preserved(self):
        (self.repo / "adapter").write_text("uncommitted work")
        with self.assertRaisesRegex(ValueError, "Commit or stash"):
            sync_upstream(self.repo)
        self.assertEqual(self.git("rev-parse", "HEAD"), self.local)
        self.assertEqual((self.repo / "adapter").read_text(), "uncommitted work")

    def test_non_main_branch_is_preserved(self):
        self.git("checkout", "-qb", "feature")
        with self.assertRaisesRegex(ValueError, "Switch.*main"):
            sync_upstream(self.repo)
        self.assertEqual(self.git("branch", "--show-current"), "feature")
        self.assertEqual(self.git("rev-parse", "HEAD"), self.local)

    def test_merge_conflict_stops_without_discarding_fork_commit(self):
        self.git("checkout", "-q", "incoming")
        (self.repo / "shared").write_text("upstream edit")
        self.git("commit", "-qam", "upstream edit")
        self.git(
            "update-ref", "refs/remotes/upstream/main", self.git("rev-parse", "HEAD")
        )
        self.git("checkout", "-q", "main")
        (self.repo / "shared").write_text("fork edit")
        self.git("commit", "-qam", "fork edit")
        before = self.git("rev-parse", "HEAD")
        with self.assertRaisesRegex(ValueError, "merge failed"):
            sync_upstream(self.repo)
        self.assertEqual(self.git("rev-parse", "HEAD"), before)
        self.assertEqual(self.git("diff", "--name-only", "--diff-filter=U"), "shared")
