import {
  CopilotClient,
  CopilotRequestHandler,
  RuntimeConnection,
} from "@github/copilot-sdk";
import { messagesRequest, usesMessages } from "./anthropic-request.mjs";
import { messagesResponse } from "./anthropic-stream.mjs";
import { responsesResponse } from "./responses-stream.mjs";

// The official runtime supplies authentication, account routing and model policy.
// Its request handler carries native Responses or translated Messages payloads
// without starting a second tool loop. Only Codex receives the real model output.
export async function createSdkTransport({
  cliPath = "copilot",
  directory,
  environment = process.env,
  Client = CopilotClient,
  forward = fetch,
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
        const acknowledgement = await translated.completion;
        if (!acknowledgement)
          throw new Error("Anthropic stream did not complete.");
        return Response.json(acknowledgement);
      }
      if (!response.ok) {
        job.resolve(response);
        throw new Error("Copilot Responses request denied.");
      }
      const observed = responsesResponse(response);
      job.resolve(observed.response);
      const completed = await observed.completion;
      if (!completed)
        throw new Error("Copilot Responses stream did not complete.");
      // Internal acknowledgement prevents the SDK from executing Codex's tools.
      // Preserve real token/billing accounting; this is never returned to Codex.
      return Response.json({
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
      });
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
    await client.listModels();
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
    transport: async (url, init) => {
      if (new URL(url).pathname === "/models") return Response.json(catalog);
      const payload = JSON.parse(init.body);
      const model = catalog.data.find((entry) => entry.id === payload.model);
      const messages = usesMessages(model)
        ? messagesRequest(payload, model)
        : undefined;
      const session = await client.createSession({
        model: payload.model,
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
        messages,
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
          job.controller.abort();
          outcome.resolve(false);
        }
        if (event.type === "session.idle" && event.data?.mode !== "autopilot")
          outcome.resolve(true);
      });
      const abort = () => {
        job.reject(new Error("Codex request cancelled."));
        job.controller.abort();
        outcome.resolve(false);
        void session.abort().catch(() => {});
      };
      job.abort = abort;
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
      await client.stop();
      await Promise.allSettled(tasks);
    },
  };
}
