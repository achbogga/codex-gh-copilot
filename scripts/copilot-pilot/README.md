# Codex with a GitHub Copilot seat

This fork's experimental adapter runs **real Codex**, including Code Mode, its native tool loop, apply_patch, shell commands and session history. The official GitHub Copilot SDK handles the existing CLI login, account routing and model catalog. Its [request handler](https://github.com/github/copilot-sdk/blob/main/nodejs/src/copilotRequestHandler.ts) forwards the original Codex Responses request and streams the original response back to Codex. It does not translate tool schemas or run a second coding agent.

## Run on Linux

Requires Node.js 22+, Docker, an authenticated `copilot` CLI (tested with 1.0.83), and the complete installed Codex executable bundle (tested with 0.154.0).

```bash
npm ci --prefix scripts/copilot-pilot --ignore-scripts
node scripts/copilot-pilot/docker-run.mjs -C /path/to/project
# Arguments after -- go to Codex:
node scripts/copilot-pilot/docker-run.mjs -C /path/to/project -- resume --last
```

The configured machine also has `codex-copilot` and Bash alias `cx`. Defaults are GPT-5.6 Sol, max reasoning, and the advertised context limit, with compaction headroom below the provider's prompt limit. `--model`, `--reasoning`, `--state-dir`, `--copilot-bin`, and `--codex-bin` override these choices. The native Codex binary must have its companion executables, including `codex-code-mode-host`, beside it. Changes to Rust are unnecessary for this transport integration.

## Isolation and capabilities

The host currently blocks Codex's bubblewrap setup. The launcher therefore uses a restricted Docker container: read-only root filesystem, no Linux capabilities, no privilege escalation, only the chosen project and dedicated Codex state writable, and existing `.git`, `.codex`, and `.agents` directories mounted read-only. Codex's inner sandbox is disabled **only inside this container**. Host security settings are unchanged. The Node container image is pinned by digest.

GitHub credentials remain with the host Copilot runtime. A private Unix socket and random local bearer connect container Codex to the model adapter. The container receives neither the host home directory nor the Docker socket. Conversation state persists in `~/.codex-copilot-pilot/codex-home`.

- Tool networking is disabled by default. For tasks requiring package downloads or network tools, explicitly launch with `--network bridge`; it enables container outbound networking.
- Use `--allow-git-write` when the task requires commits or branch changes. Agent configuration directories remain read-only.
- Pass `-- --yolo` to disable Codex approval prompts inside Docker. On the configured machine, `cxf` combines `--network bridge --allow-git-write -- --yolo`; reload Bash aliases with `source ~/.bash_aliases` after changes. Docker's outer restrictions still apply.
- The container has its own installed tools. Host-installed tools, MCP servers, plugins and credentials are not automatically imported. This is a Linux launcher, not a drop-in environment clone.
- ChatGPT-hosted features are not conferred by a Copilot seat. Copilot-specific governance controls are not automatically equivalent to Codex's controls; enterprise approval of this custom client and its data handling remains an organizational question.
- Access denials and unsupported models fail closed. Inference requests are not retried automatically, upstream HTTP error bodies are suppressed, requests are bounded to 8 MiB, and a disconnected caller cancels inference. TLS verification stays enabled.

The SDK transport hook is experimental and pinned to SDK 1.0.13. Its internal completion acknowledgement preserves the real usage/accounting while preventing the runtime from executing Codex tool calls; only the unmodified upstream output reaches Codex.

## Installation and upstream checks on the configured machine

`~/.local/bin/codex-copilot` points to this checkout's `docker-run.mjs` and the installed npm Codex executable bundle. The adapter source is used directly; this setup does not build the fork's Rust source. Codex, Copilot CLI, the SDK dependency, and the container image have separate versions.

The `codex-copilot-updates.timer` user service checks daily between 10:00 and 10:30 UTC and catches up after downtime. It fetches the official `upstream/main` reference and compares installed Codex, Copilot CLI and SDK versions with their latest stable GitHub releases. Prereleases are excluded. Fetching does not merge source changes or install packages; upgrades need compatibility checks before adopting them.

```bash
codex-copilot-updates        # Fetch upstream and check now
codex-copilot-updates --show # Read the cached report
systemctl --user list-timers codex-copilot-updates.timer
```

Release reminders appear when launching `codex-copilot`, `cx`, or `cxf` in a terminal. Failed checks and reports older than three days also produce a notice. These are local terminal reminders; they do not send email or chat messages. Configuration and results live in `~/.codex-copilot-pilot/update-config.json` and `update-report.json`. The monitor uses public GitHub metadata and does not read Copilot credentials.

Stop scheduled checks with `systemctl --user disable --now codex-copilot-updates.timer`. To adopt upstream source, first review `git log HEAD..upstream/main`; fetching alone does not update the installed Codex binary.

## Validation

```bash
node --test scripts/copilot-pilot/pilot.test.mjs scripts/copilot-pilot/sdk-transport.test.mjs
python3 -m unittest discover -s scripts/copilot-pilot -p 'update_check_test.py'
```

Live checks on this machine covered real Codex inference, Code Mode file reads, a native apply_patch edit, shell execution, three independently checked tests, and session resume. Automated checks cover byte-preserving forwarding, authentication boundaries, policy/quota errors, cancellation and prevention of a second SDK inference/tool loop. This is a compatibility pilot, not a proof of parity for every Codex feature.

The earlier direct-token experiment remains in `run.mjs`. Its generic endpoint did not expose the needed models for this account; use the SDK launcher above.
