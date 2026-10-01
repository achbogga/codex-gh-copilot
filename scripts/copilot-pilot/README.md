# Codex with a GitHub Copilot seat

This fork's experimental adapter runs **real Codex**, including Code Mode, its native tool loop, apply_patch, shell commands and session history. The official GitHub Copilot SDK handles the existing CLI login, account routing and model catalog. Its [request handler](https://github.com/github/copilot-sdk/blob/main/nodejs/src/copilotRequestHandler.ts) forwards the original Codex Responses request and streams the original response back to Codex. It does not translate tool schemas or run a second coding agent.

## Run on Linux

Requires Node.js 22+, an authenticated `copilot` CLI (tested with 1.0.91), and the installed Codex executable bundle (tested with 0.160.0). Docker is needed only for the optional container launcher.

```bash
npm ci --prefix scripts/copilot-pilot --ignore-scripts
node scripts/copilot-pilot/host-run.mjs -C /path/to/project
# Arguments after -- go to Codex:
node scripts/copilot-pilot/host-run.mjs -C /path/to/project -- resume --last
```

The configured machine has `codex-copilot` and Bash aliases `cx` and `cxf`, all using the host launcher. Both launchers default to GPT-6.1 Sol (`gpt-6.1-sol`), max reasoning, and the full advertised context limit. The enabled Copilot catalog currently advertises 1,050,000 total context tokens, with a 922,000-token input limit and 128,000-token output limit. Auto-compaction retains headroom at 95% of the input limit (875,900 tokens). Limits are read from the provider catalog at launch. `--model`, `--reasoning`, `--state-dir`, `--copilot-bin`, and `--codex-bin` override these choices. The Codex binary must retain its companion executables, including `codex-code-mode-host`. Changes to Rust are unnecessary for this transport integration.

## Host shell access

Host mode runs Codex directly as the invoking OS user with YOLO enabled: `danger-full-access` and no approval prompts. It can read and write the user's home and other locations permitted by ordinary OS permissions, use host binaries on the inherited PATH, and use the host network. Launching from a project does not restrict access to that directory. Root privileges are not added.

All exported environment variables, including credentials, are inherited. Codex shell policy uses `inherit="all"` and `ignore_default_excludes=true`. The launcher supplies its own `CODEX_HOME` and local model-bridge token. Conversation history stays in `~/.codex-copilot-pilot/codex-home`, so existing Copilot sessions remain available. Shell startup files and managed policies still apply; unexported variables in another shell are not process environment variables.

`cxf` expands to `codex-copilot -- --yolo`. Reload it with `source ~/.bash_aliases` and restart any already-running Docker session to get host access. The host launcher also accepts the former alias's `--network bridge --allow-git-write` flags for compatibility with existing shells. Model traffic still uses the official Copilot SDK through an authenticated loopback bridge; full host mode does not isolate local credentials from Codex's tools.

## Optional Docker isolation

`codex-copilot-docker` retains the previous container launcher, also available directly as `node scripts/copilot-pilot/docker-run.mjs`. It uses a read-only root filesystem, no Linux capabilities, no privilege escalation, only the chosen project and dedicated Codex state writable, and existing `.git`, `.codex`, and `.agents` directories mounted read-only. Codex's inner sandbox is disabled inside the container; Docker supplies the outer restriction. The Node image is pinned by digest.

In Docker mode, GitHub credentials remain outside the container. A private Unix socket and random local bearer connect container Codex to the model adapter. The container receives neither the host home directory nor the Docker socket.

- Tool networking is disabled by default. For tasks requiring package downloads or network tools, explicitly launch with `--network bridge`; it enables container outbound networking.
- Use `--allow-git-write` when the task requires commits or branch changes. Agent configuration directories remain read-only.
- Pass `-- --yolo` to disable Codex approval prompts inside Docker. Docker's outer restrictions still apply.
- The container has its own installed tools. Host-installed tools, MCP servers, plugins and credentials are not automatically imported. This is a Linux launcher, not a drop-in environment clone.

## Model transport limits

- ChatGPT-hosted features are not conferred by a Copilot seat. Copilot-specific governance controls are not automatically equivalent to Codex's controls; enterprise approval of this custom client and its data handling remains an organizational question.
- Access denials and unsupported models fail closed. Inference requests are not retried automatically, upstream HTTP error bodies are suppressed, requests are bounded to 8 MiB, and a disconnected caller cancels inference. TLS verification stays enabled.

The SDK transport hook is experimental and pinned to SDK 1.0.16. Its internal completion acknowledgement preserves the real usage/accounting while preventing the runtime from executing Codex tool calls; only the unmodified upstream output reaches Codex.

## Installation and upstream checks on the configured machine

`~/.local/bin/codex-copilot` points to this checkout's `host-run.mjs` and the installed npm Codex executable bundle. `~/.local/bin/codex-copilot-docker` points to `docker-run.mjs`. The adapter source is used directly; this setup does not build the fork's Rust source. Codex, Copilot CLI, the SDK dependency, and the optional container image have separate versions.

The `codex-copilot-updates.timer` user service checks daily between 10:00 and 10:30 UTC and catches up after downtime. It fetches the official `upstream/main` reference and compares installed Codex, Copilot CLI and SDK versions with their latest stable GitHub releases. Prereleases are excluded. Fetching does not merge source changes or install packages; upgrades need compatibility checks before adopting them.

```bash
cxf update         # Fetch and merge upstream source into this fork, then check runtime releases
cxf update --check # Fetch and check only; no merge or package installation
cxf update --show  # Read the cached report
systemctl --user list-timers codex-copilot-updates.timer
```

Release reminders appear when launching `codex-copilot`, `cx`, or `cxf` in a terminal. Failed checks and reports older than three days also produce a notice. These are local terminal reminders; they do not send email or chat messages. Configuration and results live in `~/.codex-copilot-pilot/update-config.json` and `update-report.json`. The monitor uses public GitHub metadata and does not read Copilot credentials.

`cxf update` always targets the configured harness checkout, regardless of your current project. It requires a clean `main` branch, preserves fork commits through a normal merge, and stops on conflicts without resetting or stashing work. It runs without a model request or Copilot login. Runtime package upgrades remain separate compatibility-tested changes; merging source does not replace the installed Codex binary. The existing `codex-copilot-updates` command remains a check-only alias.

Stop scheduled checks with `systemctl --user disable --now codex-copilot-updates.timer`. To adopt upstream source, first review `git log HEAD..upstream/main`; fetching alone does not update the installed Codex binary.

## Validation

```bash
node --test scripts/copilot-pilot/pilot.test.mjs scripts/copilot-pilot/sdk-transport.test.mjs scripts/copilot-pilot/host-run.test.mjs scripts/copilot-pilot/update-command.test.mjs
python3 -m unittest discover -s scripts/copilot-pilot -p 'update*_test.py'
```

Live checks on this machine covered real Codex inference, Code Mode file reads, a native apply_patch edit, shell execution, three independently checked tests, and session resume. Automated checks cover byte-preserving forwarding, authentication boundaries, policy/quota errors, cancellation, prevention of a second SDK inference/tool loop, and host launch behavior including environment inheritance and access outside the launch directory. This is a compatibility pilot, not a proof of parity for every Codex feature.

The live host-access check additionally verified the real HOME, reading and writing outside the launch directory, changing to that directory, host Node and Cargo availability, and inheritance of synthetic TOKEN and KEY environment variables without printing real credentials.

The GPT-6.1 Sol default was verified with Codex 0.160.0, Copilot CLI 1.0.91 and SDK 1.0.16: native file reads, apply_patch, and four passing shell-run tests. The running process used max reasoning, a 1,050,000-token context window, and the 875,900-token compaction threshold.

The earlier direct-token experiment remains in `run.mjs`. Its generic endpoint did not expose the needed models for this account; use the SDK launcher above.
