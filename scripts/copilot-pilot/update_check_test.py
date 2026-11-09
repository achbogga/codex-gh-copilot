import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from update_check import display, release_status, version, refresh_installed_report


class UpdateCheckTests(unittest.TestCase):
    def test_verified_install_clears_old_banner_without_hiding_newer_releases_or_errors(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'update-report.json'
            report = {'checked_at': '2026-11-09T19:01:00+00:00', 'errors': ['prior lookup error'],
                'releases': [
                    {'name': 'Codex', 'installed': '0.166.0', 'latest': '0.167.0', 'update_available': True},
                    {'name': 'Copilot CLI', 'installed': '1.0.105', 'latest': '1.0.108', 'update_available': True},
                    {'name': 'Copilot SDK', 'installed': '1.0.28', 'latest': '1.0.31', 'update_available': True}]}
            path.write_text(json.dumps(report))
            self.assertTrue(refresh_installed_report(path, {'codex': '0.167.0', 'copilot_cli': '1.0.108', 'copilot_sdk': '1.0.30'}))
            current = json.loads(path.read_text())
            self.assertEqual([r['installed'] for r in current['releases']], ['0.167.0', '1.0.108', '1.0.30'])
            self.assertEqual([r['update_available'] for r in current['releases']], [False, False, True])
            self.assertEqual(current['checked_at'], report['checked_at'])
            self.assertEqual(current['errors'], report['errors'])
            self.assertIn('installed_versions_checked_at', current)

    def test_missing_or_invalid_notice_cache_is_not_replaced_with_invented_release_data(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'update-report.json'
            self.assertFalse(refresh_installed_report(path, {'codex': '0.167.0'}))
            self.assertFalse(path.exists())
            path.write_text('invalid JSON')
            self.assertFalse(refresh_installed_report(path, {'codex': '0.167.0'}))
            self.assertEqual(path.read_text(), 'invalid JSON')

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
