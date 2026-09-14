import {
  CopilotClient,
  CopilotRequestHandler,
  RuntimeConnection,
} from "@github/copilot-sdk";

// The official runtime supplies authentication, account routing and model policy.
// Its documented request handler carries Codex's native Responses payload instead
// of starting a second tool loop. Only Codex receives the real model output.
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
      if (url.pathname !== "/responses" || !job || job.started)
        throw new Error("Unexpected additional runtime inference request.");
      job.started = true;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.set("x-initiator", job.init.headers["X-Initiator"]);
      const signal = AbortSignal.any([context.signal, job.init.signal]);
      const response = await forward(
        new Request(url, {
          method: "POST",
          headers,
          body: job.init.body,
          signal,
          redirect: "error",
        }),
      );
      let completed;
      if (!response.ok) job.resolve(response);
      else {
        // Observe completion for SDK accounting without rewriting a byte sent to Codex.
        const done = Promise.withResolvers();
        const decoder = new TextDecoder();
        let buffer = "";
        const body = response.body.pipeThrough(
          new TransformStream({
            transform(chunk, controller) {
              buffer += decoder.decode(chunk, { stream: true });
              if (buffer.length > 8 * 1024 * 1024)
                throw new Error("Oversized Copilot event.");
              let end;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end).trimEnd();
                buffer = buffer.slice(end + 1);
                if (
                  line.startsWith("data: {") &&
                  line.includes('"response.completed"')
                ) {
                  const event = JSON.parse(line.slice(6));
                  if (event.type === "response.completed") completed = event;
                }
              }
              controller.enqueue(chunk);
            },
            flush() {
              done.resolve();
            },
          }),
        );
        signal.addEventListener("abort", () => done.resolve(), { once: true });
        job.resolve(
          new Response(body, {
            status: response.status,
            headers: response.headers,
          }),
        );
        await done.promise;
      }
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
      const job = { ...Promise.withResolvers(), init, started: false };
      pending.set(session.sessionId, job);
      const abort = () => {
        job.reject(new Error("Codex request cancelled."));
        void session.abort().catch(() => {});
      };
      init.signal.addEventListener("abort", abort, { once: true });
      if (init.signal.aborted) abort();
      const task = session
        .sendAndWait({ prompt: "Forward the pending Codex request." }, 300000)
        .catch(() => job.reject(new Error("Copilot runtime request failed.")))
        .finally(async () => {
          job.reject(
            new Error(
              "Copilot runtime finished without returning an inference response.",
            ),
          );
          init.signal.removeEventListener("abort", abort);
          pending.delete(session.sessionId);
          await session.disconnect().catch(() => {});
          tasks.delete(task);
        });
      tasks.add(task);
      return job.promise;
    },
    close: async () => {
      await client.stop();
      await Promise.allSettled(tasks);
    },
  };
}
