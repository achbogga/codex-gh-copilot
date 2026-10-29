import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSdkTransport } from "./sdk-transport.mjs";
import { responsesThinkingPrefix } from "./responses-tools.mjs";
import { sealModelState } from "./model-state.mjs";
import { httpFailure } from "./request-errors.mjs";

async function fixture(
  t,
  upstream,
  replay = false,
  messages = false,
  headerTimeoutMs,
  modelId = "test-model",
  diagnosticFile,
  catalogModels,
  failure = {},
) {
  const requests = [],
    acknowledgements = [],
    sessions = [],
    deletedSessions = [],
    responseStarts = [],
    runtimeEvents = [];
  const catalog = {
    data: catalogModels ?? [
      messages
        ? {
            id: "claude-opus-5.5",
            supported_endpoints: ["/v1/messages"],
            capabilities: {
              supports: { adaptive_thinking: true, reasoning_effort: ["max"] },
              limits: {
                max_output_tokens: 128000,
                max_context_window_tokens: 1000000,
              },
            },
          }
        : {
            id: modelId,
            policy: { state: "enabled" },
            capabilities: { supports: { reasoning_effort: ["max"] } },
          },
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
      if (failure.create) throw failure.create;
      assert.deepEqual(options.availableTools, []);
      assert.equal(options.streaming, true);
      assert.equal(
        (await options.onPermissionRequest({ kind: "shell" })).kind,
        "reject",
        "The current SDK permission protocol must deny tool execution.",
      );
      sessions.push({
        model: options.model,
        contextTier: options.contextTier,
        reasoningEffort: options.reasoningEffort,
      });
      const controller = new AbortController();
      let listener;
      return {
        on: (handler) => {
          listener = handler;
          return () => {
            listener = undefined;
          };
        },
        sessionId: "test-session",
        abort: async () => controller.abort(),
        disconnect: async () => {},
        send: async () => {
          if (failure.send) throw failure.send;
          if (failure.event) {
            listener?.({ type: "session.error", data: failure.event });
            return;
          }
          const send = () =>
            this.handler.sendRequest(
              new Request(
                `https://api.enterprise.githubcopilot.com${failure.path ?? (messages ? "/v1/messages" : "/responses")}`,
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
          let timer;
          try {
            const response = headerTimeoutMs
              ? await Promise.race([
                  send(),
                  new Promise((_, reject) => {
                    timer = setTimeout(() => {
                      controller.abort();
                      reject(
                        new Error("Synthetic SDK response-header timeout."),
                      );
                    }, headerTimeoutMs);
                  }),
                ])
              : await send();
            clearTimeout(timer);
            responseStarts.push({ status: response.status });
            assert.match(
              response.headers.get("content-type"),
              /^text\/event-stream/,
            );
            let buffer = "",
              message,
              text = "",
              completed;
            for await (const chunk of response.body) {
              buffer += Buffer.from(chunk).toString();
              let end;
              while ((end = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, end);
                buffer = buffer.slice(end + 1);
                if (!line.startsWith("data: ")) continue;
                const event = JSON.parse(line.slice(6));
                runtimeEvents.push(event);
                if (event.type === "response.completed")
                  completed = event.response;
                if (event.type === "message_start") message = event.message;
                if (event.type === "content_block_delta")
                  text += event.delta.text;
                if (event.type === "message_delta") {
                  Object.assign(message, event.delta);
                  Object.assign(message.usage, event.usage);
                  if (event.copilot_usage)
                    message.copilot_usage = event.copilot_usage;
                }
                if (event.type === "message_stop")
                  completed = { ...message, content: [{ type: "text", text }] };
              }
            }
            if (completed) acknowledgements.push(completed);
          } finally {
            clearTimeout(timer);
          }
          if (replay) await send();
          listener?.({ type: "session.idle", data: {} });
        },
      };
    }
    async stop() {}
    async deleteSession(id) {
      assert.equal(id, "test-session", "Only this transport session is owned.");
      deletedSessions.push(id);
    }
  }
  const sdk = await createSdkTransport({
    Client,
    diagnosticFile,
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
  return {
    ...sdk,
    requests,
    acknowledgements,
    catalog,
    sessions,
    responseStarts,
    runtimeEvents,
    deletedSessions,
  };
}

const init = (signal) => ({
  body: JSON.stringify({
    model: "test-model",
    reasoning: { effort: "max" },
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

test("SDK classifies context-overflow denials before teardown consumes the error response", async (t) => {
  const sdk = await fixture(t, () =>
    Response.json(
      {
        error: {
          code: "invalid_request_body",
          message:
            "Your input exceeds the context window of this model. Please adjust your input and try again.",
          private_context: "PRIVATE_PROMPT",
        },
      },
      { status: 400 },
    ),
  );
  const response = await sdk.transport(
    "https://api.githubcopilot.com/responses",
    init(new AbortController().signal),
  );
  assert.equal(response.status, 400);
  assert.equal(
    response.bodyUsed,
    true,
    "Classification must precede returning the response to native Codex.",
  );
  assert.deepEqual(await httpFailure(response), {
    code: "invalid_request_body",
    contextExceeded: true,
  });
  await sdk.close();
  assert.equal(sdk.requests.length, 1);
  assert.deepEqual(sdk.deletedSessions, ["test-session"]);
  assert.equal(sdk.acknowledgements.length, 0);
});

test("the first provider connection error survives SDK error handling and cleans up its transport session", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-first-error-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "diagnostics.jsonl");
  const sdk = await fixture(
    t,
    () => {
      throw new TypeError("PRIVATE_REQUEST", {
        cause: Object.assign(new Error("PRIVATE_TOKEN"), {
          code: "ECONNRESET",
        }),
      });
    },
    false,
    false,
    undefined,
    "test-model",
    file,
  );
  await assert.rejects(
    sdk.transport(
      "https://api.githubcopilot.com/responses",
      init(new AbortController().signal),
    ),
    { code: "ECONNRESET" },
  );
  await sdk.close();
  assert.equal(sdk.requests.length, 1);
  assert.deepEqual(sdk.deletedSessions, ["test-session"]);
  const text = await readFile(file, "utf8");
  const diagnostics = text.trim().split("\n").map(JSON.parse);
  assert.equal(diagnostics[0].code, "ECONNRESET");
  assert.equal(diagnostics[0].stage, "runtime_request");
  assert.equal(diagnostics[0].response_returned, false);
  assert.doesNotMatch(text, /PRIVATE_|additional runtime|authorization/i);
});

for (const [failure, expected, stage] of [
  [
    { create: new Error("session.create ENOSPC PRIVATE_DATA") },
    "ENOSPC",
    "session_create",
  ],
  [
    { send: Object.assign(new Error("PRIVATE_DATA"), { code: "EPIPE" }) },
    "EPIPE",
    "session_send",
  ],
  [
    { event: { errorType: "authentication", message: "PRIVATE_TOKEN" } },
    "COPILOT_SDK_AUTHENTICATION",
    "runtime_event",
  ],
  [
    { event: { errorType: "quota", message: "PRIVATE_BUDGET" } },
    "COPILOT_SDK_QUOTA",
    "runtime_event",
  ],
  [
    { path: "/chat/completions" },
    "COPILOT_RUNTIME_ENDPOINT",
    "runtime_request",
  ],
])
  test(`early ${stage} failure preserves ${expected} without a provider request`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "copilot-early-error-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const file = join(root, "diagnostics.jsonl");
    const sdk = await fixture(
      t,
      () => {
        throw new Error("Must not infer.");
      },
      false,
      false,
      undefined,
      "test-model",
      file,
      undefined,
      failure,
    );
    await assert.rejects(
      sdk.transport(
        "https://api.githubcopilot.com/responses",
        init(new AbortController().signal),
      ),
      { code: expected },
    );
    await sdk.close();
    assert.equal(sdk.requests.length, 0);
    assert.deepEqual(
      sdk.deletedSessions,
      failure.create ? [] : ["test-session"],
    );
    const text = await readFile(file, "utf8");
    const diagnostics = text.trim().split("\n").map(JSON.parse);
    assert.ok(
      diagnostics.some((d) => d.code === expected && d.stage === stage),
    );
    assert.doesNotMatch(text, /PRIVATE_|authorization|runtime-owned-token/);
  });

test("encrypted agent tasks are rejected before SDK inference with metadata-only diagnostics", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "copilot-agent-diagnostics-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "diagnostics.jsonl");
  const sdk = await fixture(
    t,
    () => {
      throw new Error("Inference must not start.");
    },
    false,
    true,
    undefined,
    "unused",
    file,
  );
  const request = init(new AbortController().signal);
  request.body = JSON.stringify({
    model: "claude-opus-5.5",
    input: [
      {
        type: "agent_message",
        author: "/root",
        recipient: "/root/opus",
        content: [
          {
            type: "encrypted_content",
            encrypted_content: "PRIVATE_TASK_CIPHERTEXT",
          },
        ],
      },
    ],
  });
  await assert.rejects(
    sdk.transport("https://api.githubcopilot.com/responses", request),
    { code: "COPILOT_ENCRYPTED_AGENT_MESSAGE" },
  );
  assert.equal(sdk.requests.length, 0);
  assert.equal(sdk.sessions.length, 0);
  const text = await readFile(file, "utf8");
  assert.equal(JSON.parse(text).code, "COPILOT_ENCRYPTED_AGENT_MESSAGE");
  assert.doesNotMatch(
    text,
    /PRIVATE_TASK_CIPHERTEXT|encrypted_content|instructions/i,
  );
});

test("SDK requests portable collaboration schemas and retains real accounting without running agent tools", async (t) => {
  const call = {
    type: "function_call",
    namespace: "collaboration",
    name: "spawn_agent",
    call_id: "child-task",
    arguments: '{"message":"Read marker.txt"}',
  };
  const completed = {
    type: "response.completed",
    response: {
      id: "task",
      output: [call],
      usage: { input_tokens: 25, output_tokens: 7 },
    },
    copilot_usage: { total_nano_aiu: 42 },
  };
  const sdk = await fixture(
    t,
    () =>
      new Response(`data: ${JSON.stringify(completed)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      }),
  );
  const request = init(new AbortController().signal);
  request.body = JSON.stringify({
    model: "test-model",
    tools: [
      {
        type: "namespace",
        name: "collaboration",
        tools: [
          {
            type: "function",
            name: "spawn_agent",
            parameters: {
              type: "object",
              properties: { message: { type: "string", encrypted: true } },
            },
          },
        ],
      },
    ],
    input: "Read marker.txt",
  });
  const text = await (
    await sdk.transport("https://api.githubcopilot.com/responses", request)
  ).text();
  const result = JSON.parse(text.slice(6));
  assert.deepEqual(result.response.output[0].encrypted_function_args, []);
  assert.equal(
    JSON.parse(sdk.requests[0].body).tools[0].tools[0].parameters.properties
      .message.encrypted,
    undefined,
  );
  await sdk.close();
  assert.equal(sdk.requests.length, 1);
  assert.equal(sdk.acknowledgements[0].copilot_usage.total_nano_aiu, 42);
});

test("a fresh bridge omits saved foreign Responses reasoning when resuming GPT", async (t) => {
  const sdk = await fixture(
    t,
    () =>
      new Response(
        'data: {"type":"response.completed","response":{"id":"done","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    false,
    false,
    undefined,
    "gpt-test",
  );
  const history = [
    {
      type: "reasoning",
      encrypted_content: responsesThinkingPrefix + "foreign-opaque-state",
    },
    { role: "user", content: "Remember the completed work." },
  ];
  const request = init(new AbortController().signal);
  request.body = JSON.stringify({ model: "gpt-test", input: history });
  await (
    await sdk.transport("https://api.githubcopilot.com/responses", request)
  ).text();
  assert.deepEqual(JSON.parse(sdk.requests[0].body).input, [history[1]]);
});

test("a fresh SDK replays durable GPT ciphertext across GPT models and omits unknown raw state", async (t) => {
  const sdk = await fixture(
    t,
    () =>
      new Response(
        'data: {"type":"response.completed","response":{"id":"done","output":[]}}\n\n',
        { headers: { "content-type": "text/event-stream" } },
      ),
    false,
    false,
    undefined,
    "gpt-test",
  );
  const own = { type: "reasoning", encrypted_content: "own-original-bytes" };
  const foreign = {
    type: "reasoning",
    encrypted_content: "foreign-original-bytes",
  };
  const call = {
    type: "custom_tool_call",
    id: "msg_claude_1",
    call_id: "native-link",
    name: "exec",
    input: "text(1)",
  };
  const result = {
    type: "custom_tool_call_output",
    call_id: call.call_id,
    output: "1",
  };
  const user = {
    role: "user",
    content: "Continue with complete session history.",
  };
  const input = JSON.parse(
    JSON.stringify([
      sealModelState(own, "gpt-test"),
      sealModelState(foreign, "gpt-other"),
      foreign,
      call,
      result,
      user,
    ]),
  );
  const request = init(new AbortController().signal);
  request.body = JSON.stringify({ model: "gpt-test", input });
  await (
    await sdk.transport("https://api.githubcopilot.com/responses", request)
  ).text();
  const { id, ...portableCall } = call;
  assert.deepEqual(JSON.parse(sdk.requests[0].body).input, [
    own,
    foreign,
    portableCall,
    result,
    user,
  ]);
  assert.equal(
    input[0].encrypted_content,
    sealModelState(own, "gpt-test").encrypted_content,
  );
  assert.equal(input[3].id, call.id);
});

test("native compaction retains visible evidence and uses the authorized source with one accounted request", async (t) => {
  const models = [
    {
      id: "gpt-destination",
      policy: { state: "enabled" },
      capabilities: {
        supports: { reasoning_effort: ["max"] },
        limits: {
          max_context_window_tokens: 1000000,
          max_prompt_tokens: 872000,
        },
      },
    },
    {
      id: "gpt-source",
      policy: { state: "enabled" },
      capabilities: {
        supports: { reasoning_effort: ["high"] },
        limits: {
          max_context_window_tokens: 1000000,
          max_prompt_tokens: 936000,
        },
      },
    },
  ];
  const done = {
    type: "response.completed",
    response: {
      id: "compacted",
      output: [],
      usage: { input_tokens: 888000, output_tokens: 100 },
    },
  };
  const sdk = await fixture(
    t,
    async (request) => {
      assert.ok((await request.text()).length < 16384,
        "Opaque reasoning must not exhaust the summary request before visible history can be summarized.");
      return new Response(`data: ${JSON.stringify(done)}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    },
    false,
    false,
    undefined,
    models[0].id,
    undefined,
    models,
  );
  const original = {
    model: models[0].id,
    client_metadata: {
      "x-codex-turn-metadata": JSON.stringify({ request_kind: "compaction" }),
    },
    reasoning: { effort: "max" },
    input: [
      sealModelState(
        { type: "reasoning", encrypted_content: "exact-source-bytes".repeat(500000) },
        models[1].id,
      ),
      { type: "custom_tool_call", call_id: "write-once", name: "exec", input: "Already executed." },
      { type: "custom_tool_call_output", call_id: "write-once", output: "The publication succeeded." },
      { role: "user", content: "Native compact prompt" },
    ],
  };
  const request = init(new AbortController().signal);
  request.body = JSON.stringify(original);
  await (
    await sdk.transport("https://api.githubcopilot.com/responses", request)
  ).text();
  await sdk.close();
  assert.deepEqual(sdk.deletedSessions, ["test-session"]);
  assert.deepEqual(sdk.sessions, [
    {
      model: models[1].id,
      contextTier: "long_context",
      reasoningEffort: "high",
    },
  ]);
  assert.equal(sdk.requests.length, 1);
  const actual = JSON.parse(sdk.requests[0].body);
  assert.equal(actual.model, models[1].id);
  assert.match(actual.input[0].content[0].text, /omitted 1 opaque assistant reasoning/);
  assert.deepEqual(actual.input.slice(1), original.input.slice(1));
  assert.equal(original.input[0].encrypted_content.endsWith("exact-source-bytes"), true);
  assert.equal(original.model, models[0].id);
  assert.deepEqual(sdk.acknowledgements[0].usage, done.response.usage);
});

test(
  "SDK receives headers and liveness before long inference finishes, then only real accounting",
  { timeout: 3000 },
  async (t) => {
    const completed = {
      type: "response.completed",
      response: {
        id: "long-inference",
        usage: { input_tokens: 20, output_tokens: 7 },
      },
      copilot_usage: { total_nano_aiu: 321 },
    };
    const chunks = [];
    const sdk = await fixture(
      t,
      (request) =>
        new Response(
          new ReadableStream({
            start(controller) {
              const send = (event) => {
                const data = `data: ${JSON.stringify(event)}\n\n`;
                chunks.push(data);
                controller.enqueue(Buffer.from(data));
              };
              send({
                type: "response.created",
                response: { id: "long-inference" },
              });
              const timer = setInterval(
                () => send({ type: "response.in_progress" }),
                30,
              );
              const finish = setTimeout(() => {
                clearInterval(timer);
                request.signal.removeEventListener("abort", abort);
                send(completed);
                controller.close();
              }, 250);
              const abort = () => {
                clearInterval(timer);
                clearTimeout(finish);
                controller.error(new Error("Synthetic request cancelled."));
              };
              request.signal.addEventListener("abort", abort, { once: true });
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      false,
      false,
      80,
    );
    const response = await sdk.transport(
      "https://api.githubcopilot.com/responses",
      init(new AbortController().signal),
    );
    const output = response.text();
    while (!sdk.responseStarts.length)
      await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(sdk.responseStarts, [{ status: 200 }]);
    assert.deepEqual(
      sdk.acknowledgements,
      [],
      "Headers and activity must not acknowledge unfinished inference.",
    );
    while (
      !sdk.runtimeEvents.some(
        (event) => event.type === "response.output_text.delta",
      )
    )
      await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      !sdk.runtimeEvents.some((event) => event.type === "response.completed"),
    );
    assert.equal(
      await output,
      chunks.join(""),
      "SDK liveness must never change Codex's model stream.",
    );
    await sdk.close();
    assert.equal(sdk.requests.length, 1);
    assert.equal(sdk.acknowledgements.length, 1);
    assert.deepEqual(sdk.acknowledgements[0].usage, completed.response.usage);
    assert.deepEqual(
      sdk.acknowledgements[0].copilot_usage,
      completed.copilot_usage,
    );
    assert.equal(
      sdk.acknowledgements[0].output[0].content[0].text,
      "Forwarded to Codex.",
    );
  },
);

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
  assert.deepEqual(sdk.sessions, [
    { model: "test-model", contextTier: undefined, reasoningEffort: "max" },
  ]);
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

test("SDK preserves accounting when Codex stops reading after real completion", async (t) => {
  const completed = {
    type: "response.completed",
    response: { id: "finished", usage: { input_tokens: 12, output_tokens: 4 } },
  };
  const sdk = await fixture(
    t,
    () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              Buffer.from(`data: ${JSON.stringify(completed)}\n\n`),
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  const response = await sdk.transport(
    "https://api.githubcopilot.com/responses",
    init(new AbortController().signal),
  );
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await sdk.close();
  assert.equal(sdk.acknowledgements.length, 1);
  assert.deepEqual(sdk.acknowledgements[0].usage, completed.response.usage);
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
  assert.deepEqual(sdk.acknowledgements, []);
});

for (const failure of ["eof", "read-error", "cancel"])
  test(
    `SDK ${failure} settles without acknowledging incomplete inference or hanging shutdown`,
    { timeout: 3000 },
    async (t) => {
      let source;
      const sdk = await fixture(
        t,
        () =>
          new Response(
            new ReadableStream({
              start(controller) {
                source = controller;
                controller.enqueue(
                  new TextEncoder().encode(
                    'data: {"type":"response.created"}\n\n',
                  ),
                );
                if (failure === "eof") controller.close();
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          ),
      );
      const response = await sdk.transport(
        "https://api.githubcopilot.com/responses",
        init(new AbortController().signal),
      );
      const reader = response.body.getReader();
      assert.equal((await reader.read()).done, false);
      if (failure === "cancel") await reader.cancel();
      else {
        if (failure === "read-error")
          source.error(new Error("private upstream error"));
        await assert.rejects(reader.read());
      }
      await sdk.close();
      assert.equal(sdk.requests.length, 1);
      assert.deepEqual(sdk.acknowledgements, []);
    },
  );

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
  assert.deepEqual(sdk.sessions, [
    {
      model: "claude-opus-5.5",
      contextTier: "long_context",
      reasoningEffort: "max",
    },
  ]);
  assert.deepEqual(sdk.acknowledgements, [
    {
      ...message,
      content: [{ type: "text", text: "Forwarded to Codex." }],
      stop_reason: "end_turn",
      stop_sequence: null,
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
