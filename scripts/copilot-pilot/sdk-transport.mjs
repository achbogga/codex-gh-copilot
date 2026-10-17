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
import { createHash } from "node:crypto";
import { runtimeAcknowledgement } from "./runtime-ack.mjs";

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
  // Track provenance without copying opaque reasoning or changing GPT streams.
  // Foreign providers cannot authenticate one another's encrypted state.
  const reasoningOrigins = new Map();
  const reasoningKey = (content) =>
    typeof content === "string" && content.length
      ? createHash("sha256").update(content).digest("hex")
      : undefined;
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
        const translated = messagesResponse(response, job.messages);
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
      const observed = responsesResponse(response, {
        onReasoning: (item) => {
          const key = reasoningKey(item.encrypted_content);
          if (!key) return;
          if (reasoningOrigins.size >= 512)
            reasoningOrigins.delete(reasoningOrigins.keys().next().value);
          reasoningOrigins.set(key, job.model);
        },
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
      const payload = JSON.parse(init.body);
      const model = catalog.data.find((entry) => entry.id === payload.model);
      if (!model)
        throw new Error(
          "The selected model is not advertised by your Copilot seat.",
        );
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
        const portable = payload.input.filter((item) => {
          if (item.type !== "reasoning") return true;
          if (
            item.encrypted_content?.startsWith(thinkingPrefix) ||
            item.encrypted_content?.startsWith(responsesThinkingPrefix)
          )
            return false;
          // Grok's Responses endpoint returns opaque reasoning but rejects
          // replaying it (HTTP 400). Text and completed tool results remain.
          if (!model.id.startsWith("gpt-")) return false;
          const origin = reasoningOrigins.get(
            reasoningKey(item.encrypted_content),
          );
          return origin ? origin === model.id : model.id.startsWith("gpt-");
        });
        if (portable.length !== payload.input.length) {
          payload.input = portable;
          init = { ...init, body: JSON.stringify(payload) };
        }
      }
      const messages = usesMessages(model)
        ? messagesRequest(payload, model)
        : undefined;
      const responsesTools =
        !messages &&
        model.supported_endpoints?.includes("/responses") &&
        !model.id.startsWith("gpt-")
          ? functionToolsRequest(payload)
          : undefined;
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
          kind: "denied-no-approval-rule-and-could-not-request-from-user",
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
          await session.disconnect().catch(() => {});
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
