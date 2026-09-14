import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { listModels, startBridge } from "./bridge.mjs";

const localToken = "local-test-secret";
const localHeaders = {
  "authorization": `Bearer ${localToken}`,
  "content-type": "application/json",
};
const model = "gpt-5.4";
const payload = {
  model,
  stream: true,
  input: [{ role: "user", content: "Synthetic pilot" }],
};
const sse = (events) =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
const completed = {
  type: "response.completed",
  response: {
    id: "resp-1",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
};

async function fixture(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const transport = (url, init) => {
    assert.equal(new URL(url).origin, "https://api.githubcopilot.com");
    return fetch(
      `http://127.0.0.1:${server.address().port}${new URL(url).pathname}`,
      init,
    );
  };
  const bridge = await startBridge({
    getToken: async () => "upstream-test-secret",
    localToken,
    model,
    transport,
  });
  t.after(async () => {
    await bridge.close();
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  });
  return { ...bridge, transport };
}

function send(url, body = payload, options = {}) {
  return fetch(`${url}/responses`, {
    method: "POST",
    headers: localHeaders,
    body: JSON.stringify(body),
    ...options,
  });
}

test("preserves payload and SSE bytes; sets honest user/tool continuation headers", async (t) => {
  const requests = [];
  const events = sse([completed]);
  const bridge = await fixture(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      path: req.url,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(events.slice(0, 20));
    res.end(events.slice(20));
  });
  const continued = {
    ...payload,
    input: [
      ...payload.input,
      { type: "function_call_output", call_id: "c1", output: "ok" },
    ],
    include: ["reasoning.encrypted_content"],
    tools: [{ type: "custom", name: "apply_patch", format: { type: "text" } }],
  };
  for (const body of [payload, continued])
    assert.equal(await (await send(bridge.url, body)).text(), events);
  assert.deepEqual(
    requests.map(({ path, headers, body }) => ({
      path,
      auth: headers.authorization,
      initiator: headers["x-initiator"],
      agent: headers["user-agent"],
      body,
    })),
    [payload, continued].map((body, index) => ({
      path: "/responses",
      auth: "Bearer upstream-test-secret",
      initiator: index ? "agent" : "user",
      agent: "codex-copilot-pilot/0.1",
      body: JSON.stringify(body),
    })),
  );
});

test("rejects unauthorized, browser, wrong route, oversized and mismatched requests before upstream", async (t) => {
  let count = 0;
  const bridge = await fixture(t, (_req, res) => {
    count++;
    res.end();
  });
  const checks = [
    [bridge.url, payload, { headers: {} }, 401],
    [
      bridge.url,
      payload,
      { headers: { ...localHeaders, origin: "https://evil.example" } },
      401,
    ],
    [`${bridge.url}/unknown`, payload, {}, 404],
    [bridge.url, { ...payload, model: "other" }, {}, 400],
    [bridge.url, { ...payload, stream: false }, {}, 400],
    [bridge.url, { ...payload, input: "x".repeat(8 * 1024 * 1024) }, {}, 413],
  ];
  for (const [url, body, options, status] of checks) {
    const result = await send(url, body, options);
    assert.equal(result.status, status);
    await result.text();
  }
  assert.equal(count, 0);
});

test("redacts errors and makes no retries on auth, policy, quota or compatibility failures", async (t) => {
  for (const status of [400, 401, 403, 429, 500]) {
    let count = 0;
    const bridge = await fixture(t, (_req, res) => {
      count++;
      res.writeHead(status);
      res.end("upstream-test-secret private context");
    });
    const result = await send(bridge.url);
    assert.equal(result.status, status);
    assert.doesNotMatch(
      await result.text(),
      /upstream-test-secret|private context/,
    );
    assert.equal(count, 1);
  }
});

test("does not follow upstream redirects", async (t) => {
  let count = 0;
  const bridge = await fixture(t, (_req, res) => {
    count++;
    res.writeHead(307, { location: "http://127.0.0.1:1/steal" });
    res.end();
  });
  assert.equal((await send(bridge.url)).status, 502);
  assert.equal(count, 1);
});

test(
  "cancelling the client closes the upstream stream",
  { timeout: 5000 },
  async (t) => {
    let closed;
    const disconnected = new Promise((resolve) => {
      closed = resolve;
    });
    const bridge = await fixture(t, (_req, res) => {
      res.on("close", closed);
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(": heartbeat\n\n");
    });
    const controller = new AbortController();
    const result = await send(bridge.url, payload, {
      signal: controller.signal,
    });
    await result.body.getReader().read();
    controller.abort();
    await disconnected;
  },
);

test("catalog requires explicit policy and compatible capabilities", async () => {
  const enabled = {
    id: model,
    policy: { state: "enabled" },
    model_picker_enabled: true,
    supported_endpoints: ["/responses"],
    capabilities: { supports: { tool_calls: true, streaming: true } },
  };
  const data = [
    enabled,
    { ...enabled, policy: { state: "disabled" } },
    { ...enabled, policy: undefined },
    { ...enabled, supported_endpoints: ["/chat/completions"] },
  ];
  assert.deepEqual(
    await listModels(
      async () => "token",
      async () => Response.json({ data }),
    ),
    [enabled],
  );
});
