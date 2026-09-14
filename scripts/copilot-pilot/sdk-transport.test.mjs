import assert from "node:assert/strict";
import test from "node:test";
import { createSdkTransport } from "./sdk-transport.mjs";

async function fixture(t, upstream, replay = false) {
  const requests = [],
    acknowledgements = [];
  const catalog = {
    data: [{ id: "test-model", policy: { state: "enabled" } }],
  };
  class Client {
    constructor(options) {
      this.handler = options.requestHandler;
    }
    async start() {}
    async listModels() {
      return this.handler.sendRequest(
        new Request("https://api.enterprise.githubcopilot.com/models"),
        { signal: new AbortController().signal },
      );
    }
    async createSession(options) {
      assert.deepEqual(options.availableTools, []);
      const controller = new AbortController();
      return {
        sessionId: "test-session",
        abort: async () => controller.abort(),
        disconnect: async () => {},
        sendAndWait: async () => {
          const send = () =>
            this.handler.sendRequest(
              new Request(
                "https://api.enterprise.githubcopilot.com/responses",
                {
                  method: "POST",
                  body: "original SDK payload",
                  headers: {
                    "authorization": "Bearer runtime-owned-token",
                    "copilot-harness-id": "copilot-sdk",
                  },
                },
              ),
              { sessionId: "test-session", signal: controller.signal },
            );
          acknowledgements.push(await (await send()).json());
          if (replay) await send();
        },
      };
    }
    async stop() {}
  }
  const sdk = await createSdkTransport({
    Client,
    forward: async (request) => {
      if (request.method === "GET") return Response.json(catalog);
      requests.push({
        body: await request.clone().text(),
        authorization: request.headers.get("authorization"),
        initiator: request.headers.get("x-initiator"),
        redirect: request.redirect,
      });
      return upstream(request);
    },
  });
  t.after(() => sdk.close());
  return { ...sdk, requests, acknowledgements, catalog };
}

const init = (signal) => ({
  body: JSON.stringify({
    model: "test-model",
    tools: [{ type: "custom", name: "apply_patch" }],
    input: [
      { type: "custom_tool_call_output", call_id: "call", output: "patched" },
    ],
  }),
  headers: {
    "X-Initiator": "agent",
    "Authorization": "Bearer must-not-replace-runtime-token",
  },
  signal,
});

test("SDK transports native tool events unchanged and acknowledges without an inner tool loop", async (t) => {
  const completed = {
    type: "response.completed",
    copilot_usage: { total_nano_aiu: 123 },
    response: {
      id: "response-1",
      usage: { input_tokens: 12, output_tokens: 4 },
      output: [
        {
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "call",
          input: "patch",
        },
      ],
    },
  };
  const bytes = `data: ${JSON.stringify(completed)}\n\n`;
  const sdk = await fixture(
    t,
    () =>
      new Response(bytes, { headers: { "content-type": "text/event-stream" } }),
    true,
  );
  const request = init(new AbortController().signal);
  assert.equal(
    await (
      await sdk.transport("https://api.githubcopilot.com/responses", request)
    ).text(),
    bytes,
  );
  await sdk.close();
  assert.deepEqual(sdk.requests, [
    {
      body: request.body,
      authorization: "Bearer runtime-owned-token",
      initiator: "agent",
      redirect: "error",
    },
  ]);
  assert.deepEqual(sdk.acknowledgements, [
    {
      ...completed.response,
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
      copilot_usage: completed.copilot_usage,
    },
  ]);
});

test("SDK surfaces denied access without an inference retry", async (t) => {
  const sdk = await fixture(t, () => new Response("denied", { status: 403 }));
  const response = await sdk.transport(
    "https://api.githubcopilot.com/responses",
    init(new AbortController().signal),
  );
  assert.equal(response.status, 403);
  await sdk.close();
  assert.equal(sdk.requests.length, 1);
});

test("cancelling Codex aborts an in-flight SDK upstream", async (t) => {
  let cancelled = false;
  const sdk = await fixture(
    t,
    (request) =>
      new Promise((resolve, reject) => {
        request.signal.addEventListener(
          "abort",
          () => {
            cancelled = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      }),
  );
  const controller = new AbortController();
  const response = sdk.transport(
    "https://api.githubcopilot.com/responses",
    init(controller.signal),
  );
  const rejected = assert.rejects(response, /cancelled|failed/);
  while (!sdk.requests.length)
    await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await rejected;
  await sdk.close();
  assert.equal(cancelled, true);
});
