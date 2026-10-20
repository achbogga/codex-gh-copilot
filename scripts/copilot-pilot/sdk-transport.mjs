import {
  CopilotClient,
  CopilotRequestHandler,
  RuntimeConnection,
} from "@github/copilot-sdk";
import {
  messagesRequest,
  usesMessages,
  thinkingPrefix,
} from "./anthropic-request.mjs";
import { reasoningForModel } from "./model-config.mjs";
import {
  functionToolsRequest,
  functionToolsResponse,
  responsesThinkingPrefix,
} from "./responses-tools.mjs";
import { messagesResponse } from "./anthropic-stream.mjs";
import { responsesResponse } from "./responses-stream.mjs";
import { appendFileSync, statSync } from "node:fs";
import { runtimeAcknowledgement } from "./runtime-ack.mjs";
import {
  restoreModelState,
  modelStateResponse,
  modelStatePrefix,
  responseHistoryItem,
  compactionModel,
} from "./model-state.mjs";
import {
  portableAgentTools,
  portableAgentResponse,
} from "./agent-messages.mjs";

// The official runtime supplies authentication, account routing and model policy.
// Its request handler carries native Responses or translated Messages payloads
// without starting a second tool loop. Only Codex receives the real model output.
export async function createSdkTransport({
  cliPath = "copilot",
  directory,
  environment = process.env,
  Client = CopilotClient,
  forward = fetch,
  diagnosticFile,
} = {}) {
  if (environment.NODE_TLS_REJECT_UNAUTHORIZED === "0")
    throw new Error("TLS verification must remain enabled.");
  if (
    [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ].some((key) => environment[key])
  )
    throw new Error(
      "The SDK transport does not yet support your configured outbound proxy.",
    );
  const pending = new Map();
  const tasks = new Set();
  let catalog;
  let runtimeModels = [];
  const diagnose = (details) => {
    if (!diagnosticFile) return;
    try {
      let size = 0;
      try {
        size = statSync(diagnosticFile).size;
      } catch (error) {
        if (error.code !== "ENOENT") return;
      }
      if (size < 1024 * 1024)
        appendFileSync(
          diagnosticFile,
          JSON.stringify({ time: new Date().toISOString(), ...details }) + "\n",
          { mode: 0o600 },
        );
    } catch {} // Diagnostics must never interrupt inference.
  };
  class Handler extends CopilotRequestHandler {
    async sendRequest(request, context) {
      const url = new URL(request.url);
      if (
        !/^https:\/\/api(?:\.(?:enterprise|business|individual))?\.githubcopilot\.com$/.test(
          url.origin,
        )
      )
        throw new Error("Unexpected Copilot runtime endpoint.");
      if (request.method === "GET" && url.pathname === "/models") {
        const response = await forward(
          new Request(request, { redirect: "error", signal: context.signal }),
        );
        if (response.ok) catalog = await response.clone().json();
        return response;
      }
      const job = pending.get(context.sessionId);
      if (
        !job ||
        url.pathname !== (job.messages ? "/v1/messages" : "/responses") ||
        job.started
      )
        throw new Error("Unexpected additional runtime inference request.");
      job.started = true;
      job.sdkSignal = context.signal;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.set("x-initiator", job.init.headers["X-Initiator"]);
      const signal = AbortSignal.any([
        context.signal,
        job.init.signal,
        job.controller.signal,
      ]);
      let response = await forward(
        new Request(url, {
          method: "POST",
          headers,
          body: job.messages
            ? JSON.stringify(job.messages.body)
            : job.responsesTools
              ? JSON.stringify(job.responsesTools.body)
              : job.init.body,
          signal,
          redirect: "error",
        }),
      );
      job.init.onActivity?.();
      if (response.ok && response.body) {
        response = new Response(
          response.body.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                job.init.onActivity?.();
                job.runtimeActivity?.();
                controller.enqueue(chunk);
              },
            }),
          ),
          { status: response.status, headers: response.headers },
        );
      }
      if (job.messages) {
        if (!response.ok) {
          job.resolve(response);
          throw new Error("Copilot Anthropic request denied.");
        }
        if (
          !response.headers.get("content-type")?.startsWith("text/event-stream")
        )
          throw new Error("Expected an Anthropic event stream.");
        const translated = messagesResponse(response, job.messages, {
          onDiagnostic: (details) =>
            diagnose({
              ...details,
              model: job.model,
              request_bytes: Buffer.byteLength(job.init.body),
              elapsed_ms: Date.now() - job.startedAt,
            }),
        });
        job.resolve(translated.response);
        const runtime = runtimeAcknowledgement(
          translated.started,
          translated.completion.then((acknowledgement) => {
            if (!acknowledgement)
              throw new Error("Anthropic stream did not complete.");
            job.completed = true;
            return acknowledgement;
          }),
          () => job.controller.abort(),
          true,
        );
        job.runtimeActivity = runtime.activity;
        job.sdkResponseStarted = true;
        return runtime.response;
      }
      if (!response.ok) {
        job.resolve(response);
        throw new Error("Copilot Responses request denied.");
      }
      if (job.responsesTools)
        response = functionToolsResponse(response, job.responsesTools);
      else if (job.portableAgents) response = portableAgentResponse(response);
      if (job.model.startsWith("gpt-"))
        response = modelStateResponse(response, job.model);
      const observed = responsesResponse(response, {
        onDiagnostic: (details) =>
          diagnose({
            ...details,
            model: job.model,
            context_tier: job.contextTier ?? "default",
            reasoning_effort: job.reasoningEffort ?? "default",
            request_bytes: Buffer.byteLength(job.init.body),
            elapsed_ms: Date.now() - job.startedAt,
            sdk_cancelled: context.signal.aborted,
            caller_cancelled: job.init.signal.aborted,
            session_cancelled: job.controller.signal.aborted,
          }),
      });
      job.resolve(observed.response);
      const completion = observed.completion.then((completed) => {
        if (!completed)
          throw new Error("Copilot Responses stream did not complete.");
        job.completed = true;
        // Internal acknowledgement prevents the SDK from executing Codex's tools.
        // Preserve real token/billing accounting; this is never returned to Codex.
        return {
          ...(completed?.response ?? {}),
          id: completed?.response?.id ?? "codex-transport-ack",
          object: "response",
          status: "completed",
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              id: "transport-ack",
              content: [
                {
                  type: "output_text",
                  text: "Forwarded to Codex.",
                  annotations: [],
                },
              ],
            },
          ],
          ...(completed?.copilot_usage
            ? { copilot_usage: completed.copilot_usage }
            : {}),
        };
      });
      const runtime = runtimeAcknowledgement(observed.started, completion, () =>
        job.controller.abort(),
      );
      job.runtimeActivity = runtime.activity;
      job.sdkResponseStarted = true;
      return runtime.response;
    }
  }
  const client = new Client({
    connection: RuntimeConnection.forStdio({ path: cliPath, env: environment }),
    requestHandler: new Handler(),
    logLevel: "none",
    workingDirectory: directory,
  });
  try {
    await client.start();
    const listed = await client.listModels();
    if (Array.isArray(listed)) runtimeModels = listed;
  } catch {
    await client.stop();
    throw new Error(
      "Copilot SDK discovery failed; check copilot login and enterprise policy.",
    );
  }
  if (!catalog?.data) {
    await client.stop();
    throw new Error("Copilot did not return its model catalog.");
  }
  return {
    models: runtimeModels,
    transport: async (url, init) => {
      if (new URL(url).pathname === "/models") return Response.json(catalog);
      const original = JSON.parse(init.body);
      let payload = portableAgentTools(original);
      const portableAgents = payload !== original;
      if (portableAgents) init = { ...init, body: JSON.stringify(payload) };
      const model = compactionModel(
        payload,
        catalog.data.filter(
          (entry) =>
            entry.id === payload.model ||
            entry.policy?.state === "enabled" ||
            (entry.policy?.state === undefined &&
              runtimeModels.some((m) => m.id === entry.id)),
        ),
      );
      if (!model)
        throw new Error(
          "The selected model is not advertised by your Copilot seat.",
        );
      if (model.id !== payload.model) {
        diagnose({
          code: "SOURCE_MODEL_COMPACTION",
          model: model.id,
          destination_model: payload.model,
        });
        payload = { ...payload, model: model.id };
        init = { ...init, body: JSON.stringify(payload) };
      }
      const reasoningEffort = reasoningForModel(
        model,
        payload.reasoning?.effort ?? "max",
      );
      if (payload.reasoning && payload.reasoning.effort !== reasoningEffort) {
        if (reasoningEffort) payload.reasoning.effort = reasoningEffort;
        else delete payload.reasoning;
        init = { ...init, body: JSON.stringify(payload) };
      }
      if (!usesMessages(model) && Array.isArray(payload.input)) {
        let changed = false;
        const portable = payload.input.flatMap((saved) => {
          if (saved.type !== "reasoning") {
            const item = model.id.startsWith("gpt-")
              ? responseHistoryItem(saved)
              : saved;
            if (item !== saved) changed = true;
            return [item];
          }
          const item = restoreModelState(saved, model.id);
          if (item !== saved) changed = true;
          if (!item) return [];
          if (
            item.encrypted_content?.startsWith(thinkingPrefix) ||
            item.encrypted_content?.startsWith(responsesThinkingPrefix)
          ) {
            changed = true;
            return [];
          }
          // Grok's Responses endpoint returns opaque reasoning but rejects
          // replaying it (HTTP 400). Text and completed tool results remain.
          if (!model.id.startsWith("gpt-")) {
            changed = true;
            return [];
          }
          // Old raw GPT ciphertext has no durable owner. Preserve it on disk,
          // but never guess its provider after a bridge restart. New state
          // carries ownership and is restored byte-for-byte above.
          if (
            item.encrypted_content &&
            !saved.encrypted_content.startsWith(modelStatePrefix)
          ) {
            changed = true;
            return [];
          }
          return [item];
        });
        if (changed) {
          payload.input = portable;
          init = { ...init, body: JSON.stringify(payload) };
        }
      }
      let messages, responsesTools;
      try {
        messages = usesMessages(model)
          ? messagesRequest(payload, model)
          : undefined;
        responsesTools =
          !messages &&
          model.supported_endpoints?.includes("/responses") &&
          !model.id.startsWith("gpt-")
            ? functionToolsRequest(payload)
            : undefined;
      } catch (error) {
        if (error.code === "COPILOT_ENCRYPTED_AGENT_MESSAGE")
          diagnose({
            code: error.code,
            model: payload.model,
            request_bytes: Buffer.byteLength(init.body),
            reasoning_effort: reasoningEffort ?? "default",
          });
        throw error;
      }
      const contextTier =
        model?.capabilities?.limits?.max_context_window_tokens >= 1000000
          ? "long_context"
          : undefined;
      const session = await client.createSession({
        model: payload.model,
        contextTier,
        reasoningEffort,
        streaming: true,
        availableTools: [],
        onPermissionRequest: async () => ({
          kind: "reject",
          feedback: "Only the native Codex harness may execute tools.",
        }),
        capi: { enableWebSocketResponses: false },
        infiniteSessions: { enabled: false },
        systemMessage: {
          mode: "replace",
          content: "The request handler forwards inference to Codex.",
        },
      });
      const job = {
        ...Promise.withResolvers(),
        init,
        model: payload.model,
        contextTier,
        reasoningEffort,
        startedAt: Date.now(),
        messages,
        responsesTools,
        portableAgents,
        started: false,
        controller: new AbortController(),
      };
      pending.set(session.sessionId, job);
      // sendAndWait has a total-duration deadline. Let the bridge's inactivity
      // watchdog and explicit cancellation govern long, active requests instead.
      const outcome = Promise.withResolvers();
      const unsubscribe = session.on((event) => {
        if (event.agentId) return;
        if (event.type === "session.error") {
          diagnose({
            code: "SDK_SESSION_ERROR",
            model: job.model,
            context_tier: job.contextTier ?? "default",
            reasoning_effort: job.reasoningEffort ?? "default",
            request_bytes: Buffer.byteLength(job.init.body),
            elapsed_ms: Date.now() - job.startedAt,
            sdk_response_started: job.sdkResponseStarted ?? false,
            error_type: [
              "query",
              "rate_limit",
              "quota",
              "authentication",
              "connection",
              "timeout",
            ].includes(event.data?.errorType)
              ? event.data.errorType
              : "unknown",
            sdk_cancelled: job.sdkSignal?.aborted ?? false,
            caller_cancelled: job.init.signal.aborted,
            session_cancelled: job.controller.signal.aborted,
          });
          job.controller.abort();
          outcome.resolve(false);
        }
        if (event.type === "session.idle" && event.data?.mode !== "autopilot")
          outcome.resolve(true);
      });
      const abortJob = (force = false) => {
        // A caller can close immediately after the terminal SSE frame. Allow
        // the runtime to finish receiving real accounting for that completed
        // request instead of cancelling its acknowledgement during cleanup.
        if (job.completed && !force) return;
        job.reject(new Error("Codex request cancelled."));
        job.controller.abort();
        outcome.resolve(false);
        void session.abort().catch(() => {});
      };
      const abort = () => abortJob();
      job.abort = abortJob;
      init.signal.addEventListener("abort", abort, { once: true });
      if (init.signal.aborted) abort();
      const task = outcome.promise
        .then((success) => {
          if (!success)
            job.reject(new Error("Copilot runtime request failed."));
        })
        .finally(async () => {
          job.reject(
            new Error(
              "Copilot runtime finished without returning an inference response.",
            ),
          );
          init.signal.removeEventListener("abort", abort);
          unsubscribe();
          job.controller.abort();
          pending.delete(session.sessionId);
          try {
            // These sessions contain only the internal forwarding prompt and
            // accounting acknowledgement. disconnect() keeps their files and
            // can accumulate a directory for every native sampling request.
            // Delete only this newly created transport session, after idle or
            // cancellation; native Codex history has separate IDs and storage.
            await client.deleteSession(session.sessionId);
          } catch {
            diagnose({ code: "SDK_SESSION_CLEANUP_FAILED", model: job.model });
            await session.disconnect().catch(() => {});
          }
          tasks.delete(task);
        });
      tasks.add(task);
      if (!init.signal.aborted)
        void session
          .send({ prompt: "Forward the pending Codex request." })
          .catch(() => outcome.resolve(false));
      return job.promise;
    },
    close: async () => {
      for (const job of pending.values()) job.abort();
      const settled = Promise.allSettled([...tasks]);
      let timer;
      try {
        await Promise.race([
          settled,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 3000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      for (const job of pending.values()) job.abort(true);
      await client.stop();
      await settled;
    },
  };
}
