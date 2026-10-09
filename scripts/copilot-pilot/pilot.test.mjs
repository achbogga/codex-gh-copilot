import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { listModels, startBridge } from "./bridge.mjs";
import { codexInvocation, tokenSource } from "./run.mjs";

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

async function fixture(t, handler, options = {}) {
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
    ...options,
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

test(
  "active streams outlive the idle deadline without changing response bytes",
  { timeout: 5000 },
  async (t) => {
    const chunks = Array(16).fill(": activity\n\n");
    chunks.push(sse([completed]));
    const bridge = await fixture(
      t,
      async (_req, res) => {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const chunk of chunks) {
          res.write(chunk);
          await delay(25);
        }
        res.end();
      },
      { streamIdleTimeoutMs: 200 },
    );
    assert.equal(await (await send(bridge.url)).text(), chunks.join(""));
  },
);

test(
  "inactive streams cancel upstream and return a redacted error without retry or fake completion",
  { timeout: 5000 },
  async (t) => {
    let requests = 0;
    const disconnected = Promise.withResolvers();
    const bridge = await fixture(
      t,
      (_req, res) => {
        requests++;
        res.on("close", disconnected.resolve);
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.write(": activity\n\n");
      },
      { streamIdleTimeoutMs: 100 },
    );
    const output = await (await send(bridge.url)).text();
    assert.match(output, /Copilot stream inactive for 100 ms/);
    assert.doesNotMatch(output, /response.completed|upstream-test-secret/);
    await disconnected.promise;
    assert.equal(requests, 1);
  },
);

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
      res.writeHead(status, { "retry-after": "7" });
      res.end("upstream-test-secret private context");
    });
    const result = await send(bridge.url);
    assert.equal(result.status, status < 500 ? 200 : status);
    assert.equal(result.headers.get("retry-after"), "7");
    const text = await result.text();
    if (status < 500) assert.match(text, /"code":"invalid_prompt"/);
    assert.doesNotMatch(text, /upstream-test-secret|private context/);
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

test("credential source is explicit, and Codex receives only the local credential", async () => {
  assert.throws(
    () => tokenSource({ environment: { GH_TOKEN: "not-opted-in" } }),
    /Supply either/,
  );
  await assert.rejects(
    tokenSource({ command: process.execPath, environment: {} }),
    /Credential helper failed/,
  );
  const { env, args } = codexInvocation({
    model,
    url: "http://127.0.0.1:1234/v1",
    localToken,
    stateDir: "/pilot",
    args: ["exec", "synthetic"],
    environment: {
      PATH: "bin",
      COPILOT_PILOT_TOKEN: "upstream",
      GH_TOKEN: "github",
      OPENAI_API_KEY: "openai",
    },
  });
  assert.deepEqual(env, {
    PATH: "bin",
    CODEX_HOME: "/pilot",
    COPILOT_PILOT_LOCAL_TOKEN: localToken,
  });
  assert.equal(args.join(" ").includes("upstream"), false);
});

test("YOLO overrides the launcher's default approval flag", () => {
  const options = {
    model,
    url: "http://127.0.0.1:1234/v1",
    localToken,
    stateDir: "/pilot",
    environment: {},
  };
  const defaults = codexInvocation({ ...options, args: [] }).args;
  for (const flag of ["--yolo", "--dangerously-bypass-approvals-and-sandbox"]) {
    assert.deepEqual(codexInvocation({ ...options, args: [flag] }).args, [
      ...defaults.slice(0, -2),
      flag,
    ]);
  }
});

test(
  "real Codex exchanges custom/function tools and resumes",
  { skip: !process.env.COPILOT_PILOT_CODEX_BIN, timeout: 60000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "copilot-smoke-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeFile(join(directory, "value.txt"), "before");
    await mkdir(join(directory, "state"));
    const captured = [];
    const bridge = await fixture(t, async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      captured.push(JSON.parse(Buffer.concat(chunks)));
      const item =
        captured.length === 1
          ? {
              type: "custom_tool_call",
              call_id: "pilot-patch",
              name: "apply_patch",
              input:
                "*** Begin Patch\n*** Update File: value.txt\n@@\n-before\n+after\n*** End Patch",
            }
          : captured.length === 2
            ? {
                type: "function_call",
                call_id: "pilot-call",
                name: "exec_command",
                arguments: JSON.stringify({
                  cmd: "node -e \"if(require('node:fs').readFileSync('value.txt','utf8').trim()!=='after')process.exit(1);console.log('pilot-test-passed')\"",
                  max_output_tokens: 1000,
                }),
              }
            : {
                type: "message",
                role: "assistant",
                id: "msg-1",
                content: [{ type: "output_text", text: "pilot complete" }],
              };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(
        sse([
          { type: "response.created", response: { id: "resp-1" } },
          { type: "response.output_item.done", item },
          completed,
        ]),
      );
    });
    for (const args of [
      ["exec", "--skip-git-repo-check", "Run the synthetic pilot."],
      [
        "exec",
        "resume",
        "--last",
        "--skip-git-repo-check",
        "Confirm the earlier pilot.",
      ],
    ]) {
      const invocation = codexInvocation({
        model,
        url: bridge.url,
        localToken,
        stateDir: join(directory, "state"),
        args,
      });
      const pending = promisify(execFile)(
        process.env.COPILOT_PILOT_CODEX_BIN,
        invocation.args,
        {
          env: invocation.env,
          cwd: directory,
          timeout: 25000,
          maxBuffer: 1024 * 1024,
        },
      );
      pending.child.stdin.end();
      await pending;
    }
    assert.equal(captured.length, 4);
    assert.ok(
      captured[1].input.some(
        (item) =>
          item.type === "custom_tool_call_output" &&
          item.call_id === "pilot-patch",
      ),
    );
    const output = captured[2].input.find(
      (item) =>
        item.type === "function_call_output" && item.call_id === "pilot-call",
    );
    assert.ok(output);
    assert.ok(
      captured[3].input.some(
        (item) =>
          item.type === "function_call_output" && item.call_id === "pilot-call",
      ),
    );
    const blocked = output.output.includes(
      "bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted",
    );
    await t.test(
      "file edit and shell test execution",
      {
        skip: blocked
          ? "Host denies nested sandbox loopback setup; no sandbox bypass attempted."
          : false,
      },
      async () => {
        assert.equal(
          (await readFile(join(directory, "value.txt"), "utf8")).trim(),
          "after",
        );
        assert.match(output.output, /pilot-test-passed/);
      },
    );
  },
);
