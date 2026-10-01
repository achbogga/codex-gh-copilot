import assert from "node:assert/strict";
import test from "node:test";
import { createSdkTransport } from "./sdk-transport.mjs";

async function fixture(t, upstream, replay = false, messages = false) {
  const requests = [],
    acknowledgements = [];
  const catalog = {
    data: [
      messages
        ? {
            id: "claude-opus-5.5",
            supported_endpoints: ["/v1/messages"],
            capabilities: { limits: { max_output_tokens: 128000 } },
          }
        : { id: "test-model", policy: { state: "enabled" } },
    ],
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
                `https://api.enterprise.githubcopilot.com/${messages ? "v1/messages" : "responses"}`,
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

for (const messages of [false, true])
  test(`cancelling Codex aborts an in-flight SDK ${messages ? "Messages" : "Responses"} upstream`, async (t) => {
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
      false,
      messages,
    );
    const controller = new AbortController();
    const response = sdk.transport(
      "https://api.githubcopilot.com/responses",
      messages
        ? {
            ...init(controller.signal),
            body: JSON.stringify({ model: "claude-opus-5.5", input: "Hello" }),
          }
        : init(controller.signal),
    );
    const rejected = assert.rejects(response, /cancelled|failed/);
    while (!sdk.requests.length)
      await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await rejected;
    await sdk.close();
    assert.equal(cancelled, true);
  });

test("SDK translates Opus with runtime authentication and real accounting, without executing tools or retrying denial", async (t) => {
  const request = {
    ...init(new AbortController().signal),
    body: JSON.stringify({
      model: "claude-opus-5.5",
      input: "Hello",
      reasoning: { effort: "max" },
    }),
  };
  const message = {
    id: "msg_sdk",
    type: "message",
    role: "assistant",
    model: "claude-opus-5.5",
    content: [],
    usage: { input_tokens: 12, output_tokens: 3 },
  };
  const bytes = [
    { type: "message_start", message },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "Hi" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 3 },
      copilot_usage: { total_nano_aiu: 55 },
    },
    { type: "message_stop" },
  ]
    .map((value) => `data: ${JSON.stringify(value)}\n\n`)
    .join("");
  const sdk = await fixture(
    t,
    () =>
      new Response(bytes, { headers: { "content-type": "text/event-stream" } }),
    true,
    true,
  );
  assert.match(
    await (
      await sdk.transport("https://api.githubcopilot.com/responses", request)
    ).text(),
    /response.completed/,
  );
  await sdk.close();
  assert.equal(sdk.requests.length, 1);
  const sent = sdk.requests[0];
  assert.equal(sent.authorization, "Bearer runtime-owned-token");
  assert.equal(sent.initiator, "agent");
  assert.deepEqual(JSON.parse(sent.body).output_config, { effort: "max" });
  assert.deepEqual(sdk.acknowledgements, [
    {
      ...message,
      content: [{ type: "text", text: "Forwarded to Codex." }],
      stop_reason: "end_turn",
      copilot_usage: { total_nano_aiu: 55 },
    },
  ]);
  const denied = await fixture(
    t,
    () => new Response("private denial", { status: 403 }),
    false,
    true,
  );
  assert.equal(
    (await denied.transport("https://api.githubcopilot.com/responses", request))
      .status,
    403,
  );
  await denied.close();
  assert.equal(denied.requests.length, 1);
});
