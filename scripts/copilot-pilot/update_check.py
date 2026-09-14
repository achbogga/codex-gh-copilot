#!/usr/bin/env python3
"""Fetch upstream source and report stable runtime releases without installing them."""

import argparse
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.request


def version(text):
    match = re.search(r"(?<![\d.])(\d+)\.(\d+)\.(\d+)(?![\w-]|\.\w)", text)
    if not match:
        raise ValueError("Unrecognized stable version")
    return tuple(map(int, match.groups()))


def command(args, **kwargs):
    return subprocess.check_output(
        args, text=True, stderr=subprocess.PIPE, timeout=180, **kwargs
    ).strip()


def release_status(name, repository, installed):
    request = urllib.request.Request(
        f"https://api.github.com/repos/{repository}/releases/latest",
        headers={
            "User-Agent": "codex-copilot-update-check",
            "Accept": "application/vnd.github+json",
        },
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        release = json.loads(response.read(1024 * 1024))
    if release.get("draft") or release.get("prerelease"):
        raise ValueError("Expected a stable release")
    latest = ".".join(map(str, version(release["tag_name"])))
    return {
        "name": name,
        "installed": ".".join(map(str, version(installed))),
        "latest": latest,
        "update_available": version(latest) > version(installed),
        "url": f"https://github.com/{repository}/releases/tag/{release['tag_name']}",
    }


def save_report(path, report):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as stream:
        temporary = Path(stream.name)
        json.dump(report, stream, indent=2)
        stream.write("\n")
    temporary.replace(path)


def display(report, *, notice):
    if notice:
        updates = [
            f"{item['name']} {item['installed']} -> {item['latest']}"
            for item in report["releases"]
            if item["update_available"]
        ]
        if updates:
            print("[codex-copilot] Stable updates available: " + "; ".join(updates))
            print("Review: codex-copilot-updates --show")
        checked = datetime.fromisoformat(report["checked_at"])
        if report["errors"] or (datetime.now(timezone.utc) - checked).days >= 3:
            print(
                "[codex-copilot] Update checks need attention: run codex-copilot-updates"
            )
        return
    print(f"Checked: {report['checked_at']}")
    if "upstream" in report:
        upstream = report["upstream"]
        print(
            f"Upstream fetched: {upstream['commit'][:12]}; {upstream['commits_not_in_head']} commits not in local HEAD"
        )
    for item in report["releases"]:
        status = "update available" if item["update_available"] else "current"
        print(
            f"{item['name']}: installed {item['installed']}, latest stable {item['latest']} ({status})"
        )
        if item["update_available"]:
            print(f"  {item['url']}")
    for error in report["errors"]:
        print(f"Check failed: {error}")
    print(
        "Source fetch only; working files, installed binaries and dependency pins are unchanged."
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", type=Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--show",
        action="store_true",
        help="show the last report without network access",
    )
    mode.add_argument(
        "--notice", action="store_true", help="show a brief cached startup notice"
    )
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    report_path = args.config.parent / "update-report.json"
    if args.show or args.notice:
        if report_path.exists():
            display(json.loads(report_path.read_text()), notice=args.notice)
        elif args.show:
            print("No report yet. Run codex-copilot-updates.")
        return 0

    os.umask(0o077)
    with (args.config.parent / "update-check.lock").open("w") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("An update check is already running.")
            return 0
        report = {
            "checked_at": datetime.now(timezone.utc).isoformat(),
            "releases": [],
            "errors": [],
        }
        repo = Path(config["repo"])
        git = ["git", "-C", str(repo)]
        try:
            upstream_url = command([*git, "remote", "get-url", "upstream"])
            if upstream_url != "https://github.com/openai/codex.git":
                raise ValueError("Unexpected upstream remote; check its configuration")
            command(
                [
                    *git,
                    "-c",
                    "credential.helper=",
                    "-c",
                    "core.askPass=",
                    "fetch",
                    "--no-tags",
                    "upstream",
                    "+refs/heads/main:refs/remotes/upstream/main",
                ],
                env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
            )
            report["upstream"] = {
                "commit": command([*git, "rev-parse", "upstream/main"]),
                "commits_not_in_head": int(
                    command([*git, "rev-list", "--count", "HEAD..upstream/main"])
                ),
            }
        except (OSError, ValueError, subprocess.SubprocessError) as error:
            report["errors"].append(
                f"upstream fetch ({type(error).__name__}); inspect git remote -v and retry"
            )

        specifications = [
            ("Codex", "openai/codex", "codex_bin"),
            ("Copilot CLI", "github/copilot-cli", "copilot_bin"),
            ("Copilot SDK", "github/copilot-sdk", "sdk"),
        ]
        with ThreadPoolExecutor(max_workers=3) as pool:
            pending = []
            for name, repository, key in specifications:
                try:
                    if key == "sdk":
                        installed = json.loads(
                            (
                                repo
                                / "scripts/copilot-pilot/node_modules/@github/copilot-sdk/package.json"
                            ).read_text()
                        )["version"]
                    else:
                        installed = command([config[key], "--version"])
                    pending.append(
                        (name, pool.submit(release_status, name, repository, installed))
                    )
                except (
                    OSError,
                    ValueError,
                    KeyError,
                    subprocess.SubprocessError,
                ) as error:
                    report["errors"].append(
                        f"{name} installed version ({type(error).__name__})"
                    )
            for name, future in pending:
                try:
                    report["releases"].append(future.result())
                except (OSError, ValueError, KeyError) as error:
                    report["errors"].append(
                        f"{name} release lookup ({type(error).__name__})"
                    )
        save_report(report_path, report)
        display(report, notice=False)
        return int(bool(report["errors"]))


if __name__ == "__main__":
    raise SystemExit(main())
