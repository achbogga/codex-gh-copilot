import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { listModels, startBridge } from "./bridge.mjs";
import { codexInvocation } from "./run.mjs";
import { createSdkTransport } from "./sdk-transport.mjs";
import { runUpdate, updateArguments } from "./update-command.mjs";

// Host mode deliberately gives Codex the invoking user's filesystem and exported
// environment, including credentials. It does not add a container or sandbox.
export async function runHost({
  directory = process.cwd(),
  model = "gpt-5.6-sol",
  reasoning = "max",
  codexBin = "codex",
  copilotBin = "copilot",
  stateDir = join(homedir(), ".codex-copilot-pilot", "codex-home"),
  args = [],
  environment = process.env,
  connect = createSdkTransport,
} = {}) {
  const cwd = await realpath(directory);
  const state = resolve(stateDir);
  if (state === resolve(environment.CODEX_HOME ?? join(homedir(), ".codex")))
    throw new Error("Use a dedicated Copilot state directory.");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const transportDir = await mkdtemp(join(state, "transport-"));
  let sdk, bridge;
  try {
    sdk = await connect({
      cliPath: copilotBin,
      directory: transportDir,
      environment,
    });
    const selected = (
      await listModels(async () => "sdk-owned", sdk.transport)
    ).find((entry) => entry.id === model);
    if (!selected)
      throw new Error(
        "The selected Copilot model is not enabled for streaming Responses tools.",
      );
    if (!selected.capabilities.supports.reasoning_effort?.includes(reasoning))
      throw new Error("Unsupported reasoning effort for this model.");
    const localToken = randomBytes(32).toString("hex");
    bridge = await startBridge({
      getToken: async () => "sdk-owned",
      localToken,
      model,
      transport: sdk.transport,
    });
    const invocation = codexInvocation({
      model,
      url: bridge.url,
      localToken,
      stateDir: state,
      environment,
      args: [
        ...(args.some((arg) =>
          ["--yolo", "--dangerously-bypass-approvals-and-sandbox"].includes(
            arg,
          ),
        )
          ? []
          : ["--yolo"]),
        "-c",
        `model_reasoning_effort=${JSON.stringify(reasoning)}`,
        "-c",
        `model_context_window=${selected.capabilities.limits.max_context_window_tokens}`,
        "-c",
        `model_auto_compact_token_limit=${Math.floor(selected.capabilities.limits.max_prompt_tokens * 0.95)}`,
        "-c",
        'shell_environment_policy={inherit="all",ignore_default_excludes=true}',
        ...args,
      ],
    });
    invocation.args[invocation.args.indexOf("--sandbox") + 1] =
      "danger-full-access";
    const child = spawn(codexBin, invocation.args, {
      cwd,
      // Unlike the isolated launcher, host mode preserves all caller credentials.
      env: {
        ...environment,
        CODEX_HOME: state,
        COPILOT_PILOT_LOCAL_TOKEN: localToken,
      },
      stdio: "inherit",
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      return await new Promise((done, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          done(code ?? (signal === "SIGINT" ? 130 : 143)),
        );
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

async function main() {
  const separator = process.argv.indexOf("--", 2);
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2, separator < 0 ? undefined : separator),
    allowPositionals: true,
    options: {
      "directory": { type: "string", short: "C" },
      "model": { type: "string" },
      "reasoning": { type: "string" },
      "codex-bin": { type: "string" },
      "copilot-bin": { type: "string" },
      "state-dir": { type: "string" },
      // Accept the former cxf alias's flags while existing shells reload aliases.
      "network": { type: "string" },
      "allow-git-write": { type: "boolean" },
      "check": { type: "boolean" },
      "show": { type: "boolean" },
      "help": { type: "boolean", short: "h" },
    },
  });
  const forwarded = separator < 0 ? [] : process.argv.slice(separator + 1);
  const update = updateArguments([...positionals, ...forwarded]);
  if (update !== null) {
    process.exitCode = await runUpdate([
      ...update,
      ...(values.check ? ["--check"] : []),
      ...(values.show ? ["--show"] : []),
      ...(values.help ? ["--help"] : []),
    ]);
    return;
  }
  if (values.help) {
    console.log(
      "Usage: codex-copilot [-C DIRECTORY] [--model ID] [--reasoning max] [--state-dir PATH] [--codex-bin BINARY] [--copilot-bin BINARY] [-- CODEX_ARGS]\n       cxf update [--check | --show]\nRuns Codex directly on the host as your user, with YOLO, full exported environment, home and PATH access. Default: Sol/max and existing Copilot session history. For container isolation use codex-copilot-docker.",
    );
    return;
  }
  if (positionals.length)
    throw new Error("Pass Codex arguments after --; see --help.");
  if (values.network && values.network !== "bridge")
    throw new Error(
      "Host mode uses the host network. Use codex-copilot-docker --network none for isolation.",
    );
  process.exitCode = await runHost({
    directory: values.directory,
    model: values.model,
    reasoning: values.reasoning,
    codexBin: values["codex-bin"],
    copilotBin: values["copilot-bin"],
    stateDir: values["state-dir"],
    args: forwarded,
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
