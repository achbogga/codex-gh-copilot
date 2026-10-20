import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import test from "node:test";
import { startBridge } from "./bridge.mjs";
import { responsesResponse } from "./responses-stream.mjs";
import { codexInvocation } from "./run.mjs";
import { portableAgentMessage } from "./agent-messages.mjs";
import { requestError } from "./request-errors.mjs";

const encode = (events) =>
  Buffer.from(
    events.map((value) => `data: ${JSON.stringify(value)}\n\n`).join(""),
  );

const done = {
  type: "response.completed",
  response: {
    id: "done",
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  },
};
const success = [
  {
    type: "response.output_item.done",
    item: {
      type: "message",
      id: "answer",
      role: "assistant",
      content: [{ type: "output_text", text: "RECOVERED_OK" }],
    },
  },
  done,
];

for (const mode of [
  "before-tool",
  "after-tool",
  "interrupted",
  "exhausted",
  "http-denied",
  "quota-denied",
  "generic-denied",
  "encrypted-agent-denied",
  "early-connection",
  "local-storage-denied",
  "runtime-endpoint-denied",
])
  test(
    `native Codex stream recovery: ${mode}`,
    { skip: !process.env.COPILOT_PILOT_CODEX_BIN, timeout: 40000 },
    async (t) => {
      const root = await mkdtemp(join(homedir(), ".copilot-recovery-test-"));
      let bridge;
      t.after(async () => {
        await bridge?.close();
        await rm(root, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      });
      const state = join(root, "state");
      await mkdir(state);
      const requests = [];
      bridge = await startBridge({
        getToken: async () => "synthetic",
        localToken: "local",
        model: "gpt-6.1-sol",
        transport: async (_url, init) => {
          requests.push(JSON.parse(init.body));
          if (mode === "early-connection" && requests.length === 1)
            throw new TypeError("PRIVATE_CONNECTION_DETAIL", {
              cause: Object.assign(new Error("PRIVATE_TOKEN"), {
                code: "ECONNRESET",
              }),
            });
          if (mode === "local-storage-denied")
            throw Object.assign(new Error("PRIVATE_PATH"), { code: "ENOSPC" });
          if (mode === "runtime-endpoint-denied")
            throw requestError("COPILOT_RUNTIME_ENDPOINT");
          if (mode === "encrypted-agent-denied")
            portableAgentMessage({
              type: "agent_message",
              author: "/root",
              recipient: "/root/opus",
              content: [
                {
                  type: "encrypted_content",
                  encrypted_content: "private-task-ciphertext",
                },
              ],
            });
          if (mode === "http-denied")
            return new Response("private upstream denial", { status: 403 });
          let body;
          if (mode === "generic-denied")
            body = encode([
              {
                type: "error",
                code: "enterprise_policy_denied",
                message: "Synthetic denial.",
              },
            ]);
          else if (mode === "quota-denied")
            body = encode([
              {
                type: "response.failed",
                response: {
                  error: {
                    code: "insufficient_quota",
                    message: "Synthetic quota denial.",
                  },
                },
              },
            ]);
          else if (requests.length > 1 && mode !== "exhausted")
            body = encode(success);
          else if (mode === "interrupted")
            body = encode([
              {
                type: "response.incomplete",
                response: {
                  id: "partial",
                  incomplete_details: { reason: "interrupted" },
                  usage: done.response.usage,
                },
              },
            ]);
          else if (mode === "after-tool")
            body = new ReadableStream({
              async start(controller) {
                controller.enqueue(
                  encode([
                    {
                      type: "response.output_item.done",
                      item: {
                        type: "custom_tool_call",
                        call_id: "write-once",
                        name: "exec",
                        namespace: "functions",
                        input:
                          'text(await tools.exec_command({cmd: "printf once >> counter.txt", max_output_tokens: 1000}));',
                      },
                    },
                  ]),
                );
                // Drop the stream only after observing the actual side effect.
                for (let n = 0; n < 200; n++) {
                  try {
                    if (
                      (await readFile(join(root, "counter.txt"), "utf8")) ===
                      "once"
                    )
                      break;
                  } catch {}
                  await delay(25);
                }
                controller.close();
              },
            });
          else
            body = encode([
              { type: "response.created", response: { id: "dropped" } },
            ]);
          return responsesResponse(
            new Response(body, {
              headers: { "content-type": "text/event-stream" },
            }),
          ).response;
        },
      });
      const invocation = codexInvocation({
        model: "gpt-6.1-sol",
        url: bridge.url,
        localToken: "local",
        stateDir: state,
        args: [
          "--yolo",
          "exec",
          "--skip-git-repo-check",
          "--json",
          "Run the synthetic recovery check.",
        ],
      });
      let output,
        failed = false;
      try {
        const pending = promisify(execFile)(
          process.env.COPILOT_PILOT_CODEX_BIN,
          invocation.args,
          {
            cwd: root,
            env: invocation.env,
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          },
        );
        pending.child.stdin.end();
        output = await pending;
      } catch (error) {
        failed = true;
        output = error;
      }
      const text = output.stdout + output.stderr;
      assert.equal(
        failed,
        mode === "exhausted" || mode.endsWith("denied"),
        text,
      );
      assert.equal(
        requests.length,
        mode === "exhausted" ? 4 : mode.endsWith("denied") ? 1 : 2,
        text,
      );
      assert.doesNotMatch(text, /private upstream denial|PRIVATE_/);
      if (!failed) assert.match(output.stdout, /RECOVERED_OK/);
      if (mode === "after-tool") {
        assert.equal(await readFile(join(root, "counter.txt"), "utf8"), "once");
        assert.ok(
          requests[1].input.some(
            (item) =>
              item.type === "custom_tool_call_output" &&
              item.call_id === "write-once",
          ),
        );
      }
    },
  );

test(
  "native Codex classifies HTTP 413 as full context and compacts on resumed continuation",
  { skip: !process.env.COPILOT_PILOT_CODEX_BIN, timeout: 40000 },
  async (t) => {
    const root = await mkdtemp(join(homedir(), ".copilot-size-recovery-test-"));
    let bridge;
    t.after(async () => {
      await bridge?.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const state = join(root, "state");
    await mkdir(state);
    const requests = [];
    bridge = await startBridge({
      getToken: async () => "synthetic",
      localToken: "local",
      model: "gpt-6.1-sol",
      transport: async (_url, init) => {
        requests.push(JSON.parse(init.body));
        if (requests.length === 1)
          return new Response("private upstream size error", { status: 413 });
        const output =
          requests.length === 2
            ? "Synthetic compacted progress."
            : "RECOVERED_OK";
        return new Response(
          encode([
            {
              type: "response.output_item.done",
              item: {
                type: "message",
                id: "size-check",
                role: "assistant",
                content: [{ type: "output_text", text: output }],
              },
            },
            done,
          ]),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const run = async (args) => {
      const invocation = codexInvocation({
        model: "gpt-6.1-sol",
        url: bridge.url,
        localToken: "local",
        stateDir: state,
        args: [
          "--yolo",
          "-c",
          'model_reasoning_effort="max"',
          "-c",
          "model_context_window=1050000",
          ...args,
        ],
      });
      const pending = promisify(execFile)(
        process.env.COPILOT_PILOT_CODEX_BIN,
        invocation.args,
        {
          cwd: root,
          env: invocation.env,
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        },
      );
      pending.child.stdin.end();
      return pending;
    };
    let failure;
    try {
      await run([
        "exec",
        "--skip-git-repo-check",
        "--json",
        "Run the synthetic size recovery check.",
      ]);
    } catch (error) {
      failure = error;
    }
    assert.ok(
      failure,
      "The oversized request must fail without pretending it completed.",
    );
    assert.match(
      failure.stdout + failure.stderr,
      /context[_ ](?:window|length)/i,
    );
    assert.equal(
      requests.length,
      1,
      "A size rejection must not use stream retries.",
    );
    const events = failure.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const threadId = events.find(
      (event) => event.type === "thread.started",
    ).thread_id;
    const continued = await run([
      "exec",
      "resume",
      "--skip-git-repo-check",
      "--json",
      threadId,
      "Continue the synthetic size recovery check.",
    ]);
    assert.match(continued.stdout, /RECOVERED_OK/);
    assert.equal(
      requests.length,
      3,
      "Resume must summarize once before continuing inference.",
    );
    assert.equal(
      requests[1].tools?.length ?? 0,
      0,
      "Compaction must use the native summary request.",
    );
    assert.deepEqual(
      requests[2].tools,
      requests[0].tools,
      "Continuation must preserve the original tool configuration.",
    );
    assert.ok(
      JSON.stringify(requests[2].input).includes(
        "Synthetic compacted progress.",
      ),
    );
  },
);
