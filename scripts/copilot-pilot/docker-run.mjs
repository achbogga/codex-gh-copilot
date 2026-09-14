import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { listModels, startBridge } from "./bridge.mjs";
import { codexInvocation } from "./run.mjs";
import { createSdkTransport } from "./sdk-transport.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const { values, positionals } = parseArgs({
  allowPositionals: true,
  strict: true,
  args: process.argv.slice(
    2,
    process.argv.indexOf("--") < 0 ? undefined : process.argv.indexOf("--"),
  ),
  options: {
    "model": { type: "string", default: "gpt-5.6-sol" },
    "reasoning": { type: "string", default: "max" },
    "directory": { type: "string", short: "C", default: process.cwd() },
    "codex-bin": { type: "string" },
    "copilot-bin": { type: "string" },
    "state-dir": { type: "string" },
    "network": { type: "string", default: "none" },
    "allow-git-write": { type: "boolean" },
    "help": { type: "boolean", short: "h" },
  },
});

async function executable(name) {
  for (const folder of process.env.PATH.split(":")) {
    const path = join(folder, name);
    try {
      await access(path, 1);
      return await realpath(path);
    } catch {}
  }
  throw new Error(`${name} is not installed on PATH.`);
}

async function main() {
  if (values.help) {
    console.log(
      "Usage: codex-copilot [-C PROJECT] [--model ID] [--reasoning max] [--network none|bridge] [--allow-git-write] [--codex-bin NATIVE_BINARY] [-- CODEX_ARGS]\nRuns real Codex in Docker using your official Copilot CLI login. Default: Sol/max; no tool network; Git and agent metadata read-only. GitHub credentials stay on the host.",
    );
    return;
  }
  if (process.platform !== "linux")
    throw new Error(
      "This Docker launcher currently supports Linux Unix sockets only.",
    );
  if (positionals.length || !["none", "bridge"].includes(values.network))
    throw new Error("Invalid arguments; use --help.");
  const cliPath = values["copilot-bin"] ?? (await executable("copilot"));
  let binary = values["codex-bin"];
  if (!binary) {
    const installed = await executable("codex");
    binary = installed.endsWith(".js")
      ? join(
          dirname(dirname(installed)),
          `node_modules/@openai/codex-linux-${process.arch === "arm64" ? "arm64" : "x64"}/vendor/${process.arch === "arm64" ? "aarch64" : "x86_64"}-unknown-linux-musl/bin/codex`,
        )
      : installed;
  }
  binary = await realpath(binary);
  await access(join(dirname(binary), "codex-code-mode-host"));
  const cwd = await realpath(values.directory);
  let workspace = cwd;
  try {
    workspace = execFileSync(
      "git",
      ["-C", cwd, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
  } catch {}
  if ([homedir(), "/"].includes(workspace))
    throw new Error(
      "Choose a project directory instead of mounting your home or filesystem root.",
    );
  const root = join(homedir(), ".codex-copilot-pilot");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const state = resolve(values["state-dir"] ?? join(root, "codex-home"));
  if (state === resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex")))
    throw new Error("Use a dedicated Copilot state directory.");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const transportDir = await mkdtemp(join(root, "transport-"));
  let bridge, sdk;
  try {
    sdk = await createSdkTransport({ cliPath, directory: transportDir });
    const model = (
      await listModels(async () => "sdk-owned", sdk.transport)
    ).find((m) => m.id === values.model);
    if (!model)
      throw new Error(
        "The selected Copilot model is not enabled for streaming Responses tools.",
      );
    if (
      !model.capabilities.supports.reasoning_effort?.includes(values.reasoning)
    )
      throw new Error("Unsupported reasoning effort for this model.");
    const token = randomBytes(32).toString("hex");
    bridge = await startBridge({
      getToken: async () => "sdk-owned",
      localToken: token,
      model: values.model,
      transport: sdk.transport,
      socketPath: join(transportDir, "bridge.sock"),
    });
    await chmod(join(transportDir, "bridge.sock"), 0o600);
    const separator = process.argv.indexOf("--");
    const invocation = codexInvocation({
      model: values.model,
      url: bridge.url,
      localToken: token,
      stateDir: "/codex-home",
      args: [
        "-c",
        `model_reasoning_effort=${JSON.stringify(values.reasoning)}`,
        "-c",
        `model_context_window=${model.capabilities.limits.max_context_window_tokens}`,
        "-c",
        `model_auto_compact_token_limit=${Math.floor(model.capabilities.limits.max_prompt_tokens * 0.95)}`,
        ...(separator < 0 ? [] : process.argv.slice(separator + 1)),
      ],
    });
    // Only the container gets this setting. Docker enforces the outer boundary.
    invocation.args[invocation.args.indexOf("--sandbox") + 1] =
      "danger-full-access";
    const args = [
      "run",
      "--rm",
      "--init",
      "-i",
      ...(process.stdin.isTTY ? ["-t"] : []),
      "--network",
      values.network,
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--user",
      `${process.getuid()}:${process.getgid()}`,
      "--tmpfs",
      "/tmp:rw,nosuid,nodev",
      "--tmpfs",
      `/home/node:rw,nosuid,nodev,uid=${process.getuid()},gid=${process.getgid()}`,
      "-e",
      "HOME=/home/node",
      "-e",
      "SHELL=/bin/bash",
      "-e",
      "CODEX_HOME=/codex-home",
      "-e",
      "COPILOT_PILOT_LOCAL_TOKEN",
      "-e",
      `TERM=${process.env.TERM ?? "xterm-256color"}`,
    ];
    for (const [source, target, readOnly] of [
      [workspace, workspace, false],
      [state, "/codex-home", false],
      [transportDir, "/transport", true],
      [dirname(binary), "/opt/codex/bin", true],
      [join(here, "docker-entry.mjs"), "/opt/entry.mjs", true],
    ])
      args.push(
        "--mount",
        `type=bind,source=${source},target=${target}${readOnly ? ",readonly" : ""}`,
      );
    const resources = join(dirname(dirname(binary)), "codex-resources");
    try {
      await access(resources);
      args.push(
        "--mount",
        `type=bind,source=${resources},target=/opt/codex/codex-resources,readonly`,
      );
    } catch {}
    for (const name of [".git", ".codex", ".agents"]) {
      if (name === ".git" && values["allow-git-write"]) continue;
      const path = join(workspace, name);
      try {
        await access(path);
        args.push(
          "--mount",
          `type=bind,source=${path},target=${path},readonly`,
        );
      } catch {}
    }
    args.push(
      "-w",
      cwd,
      "node:24-bookworm@sha256:6dac556d980b7f0e5498d08f08cee0ca67798b4ad6c23964a9214920e67758d0",
      "node",
      "/opt/entry.mjs",
      ...invocation.args,
    );
    const child = spawn("docker", args, {
      env: { ...process.env, COPILOT_PILOT_LOCAL_TOKEN: token },
      stdio: "inherit",
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      process.exitCode = await new Promise((done, reject) => {
        child.on("error", reject);
        child.on("exit", (code) => done(code ?? 1));
      });
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    await bridge?.close();
    await sdk?.close();
    await rm(transportDir, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
