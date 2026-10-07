import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { listModels, startBridge } from "./bridge.mjs";

export function tokenSource({ command, environment = process.env }) {
  const token = environment.COPILOT_PILOT_TOKEN?.trim();
  if (Boolean(command) === Boolean(token)) {
    throw new Error(
      "Supply either COPILOT_PILOT_TOKEN or --token-command (an approved executable), not both.",
    );
  }
  if (command && !isAbsolute(command))
    throw new Error("--token-command must be an absolute executable path.");
  return async () => {
    if (token) return token;
    try {
      const pending = promisify(execFile)(command, [], {
        encoding: "utf8",
        timeout: 5000,
        maxBuffer: 16384,
        env: environment,
      });
      pending.child.stdin.end();
      const { stdout } = await pending;
      if (!stdout.trim()) throw new Error();
      return stdout.trim();
    } catch {
      throw new Error(
        "Credential helper failed; its output has been suppressed.",
      );
    }
  };
}

export function codexInvocation({
  model,
  url,
  localToken,
  stateDir,
  args,
  environment = process.env,
}) {
  const env = { ...environment };
  for (const key of [
    "COPILOT_PILOT_TOKEN",
    "COPILOT_GITHUB_TOKEN",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "OPENAI_API_KEY",
  ])
    delete env[key];
  // This is the child's dedicated Codex configuration directory, not the user's home.
  env.CODEX_HOME = stateDir;
  env.COPILOT_PILOT_LOCAL_TOKEN = localToken;
  const provider = `{ name = "Copilot pilot", base_url = "${url}", env_key = "COPILOT_PILOT_LOCAL_TOKEN", wire_api = "responses", requires_openai_auth = false, supports_websockets = false, request_max_retries = 0, stream_max_retries = 0 }`;
  return {
    env,
    args: [
      "-c",
      'model_provider="copilot-pilot"',
      "-c",
      `model=${JSON.stringify(model)}`,
      "-c",
      `model_providers.copilot-pilot=${provider}`,
      // The SDK supplies the enabled Copilot catalog and provider limits.
      // Codex 0.161 enables separate API-key discovery by default; this bridge
      // only implements Responses, not Codex's model-discovery endpoint.
      "-c",
      "features.api_key_model_discovery=false",
      "-c",
      'web_search="disabled"',
      "--sandbox",
      "workspace-write",
      ...(args.some((arg) =>
        ["--yolo", "--dangerously-bypass-approvals-and-sandbox"].includes(arg),
      )
        ? []
        : ["--ask-for-approval", "on-request"]),
      ...args,
    ],
  };
}

async function main() {
  const separator = process.argv.indexOf("--", 2);
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2, separator < 0 ? undefined : separator),
    allowPositionals: true,
    options: {
      "model": { type: "string" },
      "token-command": { type: "string" },
      "state-dir": { type: "string" },
      "codex-bin": { type: "string", default: "codex" },
      "help": { type: "boolean", short: "h" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: node scripts/copilot-pilot/run.mjs models|run [--model ID] [--token-command /absolute/helper] [--state-dir DIR] [--codex-bin PATH] [-- CODEX_ARGS]\nUse COPILOT_PILOT_TOKEN or a credential helper only after your enterprise authorizes this client. See README.md. No existing app credentials are read.",
    );
    return;
  }
  if (positionals.length !== 1 || !["models", "run"].includes(positionals[0]))
    throw new Error("Expected models or run; use --help.");
  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS verification must remain enabled.");
  if (
    [
      "HTTPS_PROXY",
      "HTTP_PROXY",
      "ALL_PROXY",
      "https_proxy",
      "http_proxy",
      "all_proxy",
    ].some((key) => process.env[key])
  ) {
    throw new Error(
      "This pilot does not support outbound proxies; use an approved client instead of bypassing your proxy.",
    );
  }
  const getToken = tokenSource({ command: values["token-command"] });
  const models = await listModels(getToken);
  if (positionals[0] === "models") {
    const summary = models.map(({ id, capabilities, billing }) => ({
      id,
      capabilities,
      billing,
    }));
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  if (!models.some(({ id }) => id === values.model))
    throw new Error(
      "Select an enabled, streaming, tool-capable Responses model from the models command.",
    );
  const temporary = !values["state-dir"];
  // Codex refuses to create executable helpers under the system temporary directory.
  const pilotRoot = join(homedir(), ".codex-copilot-pilot");
  if (temporary) await mkdir(pilotRoot, { recursive: true, mode: 0o700 });
  const stateDir = temporary
    ? await mkdtemp(join(pilotRoot, "session-"))
    : resolve(values["state-dir"]);
  const existingHome = resolve(
    process.env.CODEX_HOME ?? join(homedir(), ".codex"),
  );
  if (stateDir === existingHome)
    throw new Error(
      "Use a separate --state-dir, not your existing Codex home.",
    );
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  const localToken = randomBytes(32).toString("hex");
  const bridge = await startBridge({
    getToken,
    localToken,
    model: values.model,
  });
  try {
    const invocation = codexInvocation({
      model: values.model,
      url: bridge.url,
      localToken,
      stateDir,
      args: separator < 0 ? [] : process.argv.slice(separator + 1),
    });
    const child = spawn(values["codex-bin"], invocation.args, {
      env: invocation.env,
      stdio: "inherit",
    });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    try {
      process.exitCode = await new Promise((resolve, reject) => {
        child.once("error", () =>
          reject(new Error("Cannot start Codex; check --codex-bin.")),
        );
        child.once("exit", (code, signal) =>
          resolve(code ?? (signal === "SIGINT" ? 130 : 143)),
        );
      });
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
    }
  } finally {
    await bridge.close();
    if (temporary) await rm(stateDir, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      error instanceof TypeError || error instanceof SyntaxError
        ? "Pilot response or connection failed; check compatibility, TLS, and connectivity."
        : error.message,
    );
    process.exitCode = 1;
  });
}
