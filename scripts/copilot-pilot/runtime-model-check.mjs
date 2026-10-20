import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  CopilotClient,
  CopilotRequestHandler,
  RuntimeConnection,
} from "@github/copilot-sdk";
import { mapResponseEvents } from "./responses-events.mjs";
import { sameInferenceModel } from "./inference-model.mjs";
import { reasoningForModel } from "./model-config.mjs";

// Separate official-runtime control. Unlike the native bridge matrix, this
// deliberately lets Copilot run its own built-in tools in a generated fixture.
// Observe actual wire models: a successful fallback is not requested-model proof.
const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    model: { type: "string", default: "claude-opus-5" },
    out: { type: "string" },
  },
});
assert.ok(
  values.live && values.out && process.env.COPILOT_PILOT_RUNTIME_BIN,
  "Pass --live --out PRIVATE_DIRECTORY [--model MODEL] and COPILOT_PILOT_RUNTIME_BIN. This uses real Copilot inference.",
);
const out = resolve(values.out);
await mkdir(out, { recursive: true, mode: 0o700 });
const project = await mkdtemp(join(out, "fixture-"));
const history = "MATRIX_HISTORY_" + randomBytes(10).toString("hex"),
  proof = "MATRIX_TARGET_" + randomBytes(10).toString("hex");
await writeFile(join(project, "seed.txt"), history + "\n", { mode: 0o600 });
await writeFile(join(project, "proof.txt"), proof + "\n", { mode: 0o600 });
await writeFile(join(project, "artifact.txt"), "PATCH_BEFORE\n", {
  mode: 0o600,
});
const inference = [],
  stages = [],
  changes = [];
let stage = 0,
  catalog;
class Handler extends CopilotRequestHandler {
  async sendRequest(request, context) {
    let row;
    if (request.method === "POST") {
      const body = await request.clone().json();
      row = {
        stage,
        requested_model: body.model,
        served_model: null,
        stop_reason: null,
        refusal_category: null,
        fallback_credit_present: Boolean(body.fallback_credit_token),
      };
      inference.push(row);
    }
    const response = await super.sendRequest(request, context);
    if (
      request.method === "GET" &&
      new URL(request.url).pathname === "/models" &&
      response.ok
    )
      catalog = await response.clone().json();
    if (!row || !response.ok) return response;
    return mapResponseEvents(response, (event) => {
      const model = event.message?.model ?? event.response?.model;
      if (model) row.served_model = model;
      if (event.type === "message_delta") {
        row.stop_reason = event.delta?.stop_reason;
        const category = event.delta?.stop_details?.category;
        if (
          [
            "cyber",
            "bio",
            "frontier_llm",
            "reasoning_extraction",
            "general_harms",
          ].includes(category)
        )
          row.refusal_category = category;
      }
      return event;
    });
  }
}
const client = new CopilotClient({
  connection: RuntimeConnection.forStdio({
    path: process.env.COPILOT_PILOT_RUNTIME_BIN,
    env: { ...process.env, COPILOT_AUTO_UPDATE: "false" },
  }),
  requestHandler: new Handler(),
  workingDirectory: project,
  logLevel: "none",
});
try {
  await client.start();
  const models = await client.listModels();
  assert.ok(
    models.some((model) => model.id === values.model),
    "Select a model listed by the official runtime.",
  );
  const selected = catalog?.data?.find((model) => model.id === values.model);
  assert.ok(selected, "The runtime must return the model's actual limits.");
  const session = await client.createSession({
    model: values.model,
    reasoningEffort: reasoningForModel(selected),
    contextTier:
      selected.capabilities?.limits?.max_context_window_tokens >= 1000000
        ? "long_context"
        : undefined,
    streaming: true,
    availableTools: ["bash", "view", "edit"],
    onPermissionRequest: async (request) =>
      request.managedApprovalRequired
        ? { kind: "reject", feedback: "Managed interactive approval required." }
        : { kind: "approve-once" },
    infiniteSessions: { enabled: false },
    capi: { enableWebSocketResponses: false },
  });
  session.on((event) => {
    if (event.type === "session.model_change")
      changes.push({
        from: event.data.previousModel,
        to: event.data.newModel,
        cause: event.data.cause,
      });
  });
  const prompts = [
    `Use bash to read ${join(project, "seed.txt")}. Remember that file value for future turns. Use edit to replace PATCH_BEFORE in ${join(project, "artifact.txt")} with PATCH_AFTER_control. Reply with the seed file value. Do not spawn agents.`,
    `Use bash to read ${join(project, "proof.txt")} and ${join(project, "artifact.txt")}. Reply with the seed file value from your earlier visible answer, the new proof file value, and the artifact value. Do not read seed files, change files or spawn agents.`,
  ];
  for (; stage < prompts.length; stage++) {
    const messages = [],
      tools = [];
    const unsubscribe = session.on((event) => {
      if (event.type === "assistant.message")
        messages.push(event.data.content ?? "");
      if (event.type === "tool.execution_start")
        tools.push(event.data.toolName);
    });
    try {
      await session.sendAndWait({ prompt: prompts[stage] }, 180000);
    } finally {
      unsubscribe();
    }
    const text = messages.join("\n").replace(/[`*\s]/g, "");
    const artifact = await readFile(join(project, "artifact.txt"), "utf8");
    stages.push({
      stage,
      history: text.includes(history),
      proof: stage === 0 || text.includes(proof),
      patch: artifact.includes("PATCH_AFTER_control"),
      shell: tools.includes("bash"),
      tools,
    });
  }
} finally {
  await client.stop();
}
const report = {
  requested_model: values.model,
  task_passed:
    stages.length === 2 &&
    stages.every((s) => s.history && s.proof && s.patch && s.shell),
  requested_model_satisfied:
    inference.length > 0 &&
    inference.every((call) =>
      sameInferenceModel(values.model, call.served_model),
    ),
  stages,
  inference,
  model_changes: changes,
};
await writeFile(join(out, "report.json"), JSON.stringify(report, null, 2), {
  mode: 0o600,
});
console.log(JSON.stringify(report));
process.exitCode =
  report.task_passed && report.requested_model_satisfied ? 0 : 1;
