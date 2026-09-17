import contextlib
import io
import json
import unittest
from unittest.mock import patch

from update_check import display, release_status, version


class UpdateCheckTests(unittest.TestCase):
    def test_versions_compare_numerically_and_reject_prereleases(self):
        self.assertGreater(version("rust-v0.154.0"), version("codex-cli 0.99.0"))
        self.assertEqual(
            version(
                "GitHub Copilot CLI 1.0.83.\nRun 'copilot update' to check for updates."
            ),
            (1, 0, 83),
        )
        for tag in ["rust-v0.155.0-alpha.1", "v1.2.3-rc.1"]:
            with self.assertRaises(ValueError):
                version(tag)

    def test_release_comparison_uses_installed_version_and_ignores_downgrades(self):
        payload = {"tag_name": "rust-v0.154.0", "draft": False, "prerelease": False}
        for installed, available in [
            ("0.153.0", True),
            ("0.154.0", False),
            ("0.155.0", False),
        ]:
            with patch(
                "urllib.request.urlopen",
                return_value=io.BytesIO(json.dumps(payload).encode()),
            ):
                self.assertEqual(
                    release_status("Codex", "openai/codex", installed),
                    {
                        "name": "Codex",
                        "installed": installed,
                        "latest": "0.154.0",
                        "update_available": available,
                        "url": "https://github.com/openai/codex/releases/tag/rust-v0.154.0",
                    },
                )
        payload["prerelease"] = True
        with patch(
            "urllib.request.urlopen",
            return_value=io.BytesIO(json.dumps(payload).encode()),
        ):
            with self.assertRaises(ValueError):
                release_status("Codex", "openai/codex", "0.153.0")

    def test_startup_reports_updates_and_failed_or_stale_checks(self):
        report = {
            "checked_at": "2020-01-01T00:00:00+00:00",
            "errors": [],
            "releases": [
                {
                    "name": "Codex",
                    "installed": "0.153.0",
                    "latest": "0.154.0",
                    "update_available": True,
                },
            ],
        }
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            display(report, notice=True)
        self.assertEqual(
            output.getvalue(),
            "[codex-copilot] Stable updates available: Codex 0.153.0 -> 0.154.0\n"
            "Review: cxf update --show\n"
            "[codex-copilot] Update checks need attention: run cxf update --check\n",
        )


if __name__ == "__main__":
    unittest.main()
