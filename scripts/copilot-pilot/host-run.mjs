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
import { catalogArguments, reasoningForModel } from "./model-config.mjs";
import {
  efficiencyArguments,
  efficiencyCommand,
  manageEfficiency,
} from "./efficiency/config.mjs";

// Host mode deliberately gives Codex the invoking user's filesystem and exported
// environment, including credentials. It does not add a container or sandbox.
export function splitHostArguments(args) {
  const valued = new Set([
    "--directory",
    "-C",
    "--model",
    "-m",
    "--reasoning",
    "--codex-bin",
    "--copilot-bin",
    "--state-dir",
    "--network",
  ]);
  const switches = new Set([
    "--allow-git-write",
    "--check",
    "--show",
    "--json",
    "--help",
    "-h",
  ]);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--")
      return { args: args.slice(0, index), forwarded: args.slice(index + 1) };
    if (valued.has(arg)) {
      index++;
      continue;
    }
    if (arg.includes("=") && valued.has(arg.split("=")[0])) continue;
    if ((arg.startsWith("-m") || arg.startsWith("-C")) && arg.length > 2)
      continue;
    if (switches.has(arg)) continue;
    return { args: args.slice(0, index), forwarded: args.slice(index) };
  }
  return { args, forwarded: [] };
}

export async function runHost({
  directory = process.cwd(),
  model = "gpt-6.1-sol",
  reasoning = "max",
  codexBin = "codex",
  copilotBin = "copilot",
  stateDir = join(homedir(), ".codex-copilot-pilot", "codex-home"),
  args = [],
  environment = process.env,
  connect = createSdkTransport,
  modelsOnly = false,
  json = false,
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
      diagnosticFile: join(state, "stream-diagnostics.jsonl"),
      environment,
    });
    const models = await listModels(async () => "sdk-owned", sdk.transport, {
      messages: true,
      runtimeModelIds: sdk.models?.map((entry) => entry.id) ?? [],
    });
    if (modelsOnly) {
      const summary = models.map((entry) => ({
        id: entry.id,
        context: entry.capabilities.limits.max_context_window_tokens,
        reasoning: reasoningForModel(entry) ?? "budgeted thinking",
      }));
      console.log(
        json
          ? JSON.stringify(summary, null, 2)
          : [
              "MODEL                        CONTEXT     DEFAULT REASONING",
              ...summary.map(
                (entry) =>
                  `${entry.id.padEnd(28)} ${String(entry.context).padEnd(11)} ${entry.reasoning}`,
              ),
            ].join("\n"),
      );
      return 0;
    }
    const selected = models.find((entry) => entry.id === model);
    if (!selected)
      throw new Error(
        "The selected Copilot model is not enabled for a supported streaming tool protocol.",
      );
    reasoningForModel(selected, reasoning);
    const localToken = randomBytes(32).toString("hex");
    bridge = await startBridge({
      getToken: async () => "sdk-owned",
      localToken,
      model,
      models,
      transport: sdk.transport,
      onDiagnostic: sdk.diagnose,
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
        ...(await catalogArguments(
          models,
          selected,
          reasoning,
          join(transportDir, "models.json"),
        )),
        ...(await efficiencyArguments(state, {
          environmentKeys: Object.keys(environment),
        })),
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
  const split = splitHostArguments(process.argv.slice(2));
  const { values, positionals } = parseArgs({
    args: split.args,
    allowPositionals: true,
    options: {
      "directory": { type: "string", short: "C" },
      "model": { type: "string", short: "m" },
      "reasoning": { type: "string" },
      "codex-bin": { type: "string" },
      "copilot-bin": { type: "string" },
      "state-dir": { type: "string" },
      // Accept the former cxf alias's flags while existing shells reload aliases.
      "network": { type: "string" },
      "allow-git-write": { type: "boolean" },
      "check": { type: "boolean" },
      "show": { type: "boolean" },
      "json": { type: "boolean" },
      "help": { type: "boolean", short: "h" },
    },
  });
  const forwarded = split.forwarded;
  const commands = [...positionals, ...forwarded].filter(
    (arg) =>
      !["--yolo", "--dangerously-bypass-approvals-and-sandbox"].includes(arg),
  );
  if (commands[0] === "models") {
    process.exitCode = await runHost({
      directory: values.directory,
      copilotBin: values["copilot-bin"],
      stateDir: values["state-dir"],
      modelsOnly: true,
      json: values.json || commands.includes("--json"),
    });
    return;
  }
  const efficiency = efficiencyCommand([...positionals, ...forwarded]);
  if (efficiency !== null) {
    console.log(
      JSON.stringify(
        await manageEfficiency(
          resolve(
            values["state-dir"] ??
              join(homedir(), ".codex-copilot-pilot", "codex-home"),
          ),
          efficiency,
        ),
        null,
        2,
      ),
    );
    return;
  }
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
      "Usage: cxf [-C DIRECTORY] [-m ID] [--reasoning max] [-- CODEX_ARGS]\n       cxf models [--json]\n       cxf update [--check | --show]\n       cxf efficiency [on | off | status]\nUse /model inside Codex to switch between the models advertised by your seat. Each model uses its full context and strongest supported reasoning. Default: GPT-6.1 Sol/max, YOLO, full exported environment, home and PATH access. For container isolation use codex-copilot-docker.",
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
