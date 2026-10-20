import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { CopilotClient } from "@github/copilot-sdk";
import { listModels, startBridge } from "./bridge.mjs";
import { modelArguments } from "./model-config.mjs";
import { codexInvocation } from "./run.mjs";
import { createSdkTransport } from "./sdk-transport.mjs";

// Opt-in: the installed runtime uses the logged-in seat for model discovery.
// Every inference POST is synthetic; these checks never call a model backend.
const duration = Number(process.env.COPILOT_PILOT_LONG_STREAM_MS ?? 660000);
const cliPath = process.env.COPILOT_PILOT_RUNTIME_BIN;
const codexBin = process.env.COPILOT_PILOT_CODEX_BIN;
const models = (
  process.env.COPILOT_PILOT_STREAM_MODELS ?? "gpt-6.1-sol,claude-opus-5.5"
).split(",");
const encode = (event) => Buffer.from(`data: ${JSON.stringify(event)}\n\n`);

test(
  "official runtime preserves the first connection error and removes its failed transport session",
  {
    skip: !cliPath,
    timeout: 30000,
  },
  async (t) => {
    const root = await mkdtemp(join(homedir(), ".copilot-sdk-first-error-"));
    let sdk;
    t.after(async () => {
      await sdk?.close();
      await rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    });
    const sessionIds = [],
      deleted = [];
    let requests = 0;
    class Client extends CopilotClient {
      async createSession(options) {
        const session = await super.createSession(options);
        sessionIds.push(session.sessionId);
        return session;
      }
      async deleteSession(id) {
        assert.ok(sessionIds.includes(id));
        await super.deleteSession(id);
        deleted.push(id);
      }
    }
    const file = join(root, "diagnostics.jsonl");
    sdk = await createSdkTransport({
      Client,
      cliPath,
      directory: root,
      diagnosticFile: file,
      forward: async (request) => {
        if (request.method === "GET") return fetch(request);
        requests++;
        throw new TypeError("PRIVATE_PROVIDER_REQUEST", {
          cause: Object.assign(new Error("PRIVATE_TOKEN"), {
            code: "ECONNRESET",
          }),
        });
      },
    });
    await assert.rejects(
      sdk.transport("https://api.githubcopilot.com/responses", {
        body: JSON.stringify({
          model: "gpt-6.1-sol",
          stream: true,
          input: "Synthetic connection failure check.",
          reasoning: { effort: "max" },
        }),
        headers: { "X-Initiator": "user" },
        signal: AbortSignal.timeout(20000),
      }),
      { code: "ECONNRESET" },
    );
    await sdk.close();
    assert.equal(requests, 1);
    assert.equal(sessionIds.length, 1);
    assert.deepEqual(deleted, sessionIds);
    for (const id of sessionIds)
      await assert.rejects(
        access(join(homedir(), ".copilot", "session-state", id)),
        { code: "ENOENT" },
      );
    const text = await readFile(file, "utf8");
    const diagnostics = text.trim().split("\n").map(JSON.parse);
    assert.equal(diagnostics[0].code, "ECONNRESET");
    assert.doesNotMatch(
      text,
      /PRIVATE_|COPILOT_RUNTIME_EXTRA_REQUEST|SDK_SESSION_CLEANUP_FAILED/,
    );
  },
);

test(
  `native Codex and official runtime sustain ${duration / 1000}-second active streams`,
  { skip: !cliPath || !codexBin, concurrency: true, timeout: duration + 60000 },
  async (t) => {
    await Promise.all(
      models.map((model) =>
        t.test(model, async (t) => {
          const root = await mkdtemp(
            join(homedir(), ".copilot-sdk-runtime-test-"),
          );
          let sdk, bridge;
          t.after(async () => {
            await bridge?.close();
            await sdk?.close();
            await rm(root, {
              recursive: true,
              force: true,
              maxRetries: 5,
              retryDelay: 100,
            });
          });
          const state = join(root, "state");
          await mkdir(state, { mode: 0o700 });
          let backendRequests = 0,
            runtimeRequests = 0,
            idle = 0;
          const errors = [],
            sessions = [],
            sessionIds = [],
            deletedSessionIds = [];
          class Client extends CopilotClient {
            constructor(options) {
              if (process.env.COPILOT_PILOT_RUNTIME_DEBUG)
                options.logLevel = "debug";
              const send = options.requestHandler.sendRequest.bind(
                options.requestHandler,
              );
              options.requestHandler.sendRequest = async (request, context) => {
                if (request.method === "POST") {
                  runtimeRequests++;
                  const body = await request.clone().json();
                  if (process.env.COPILOT_PILOT_RUNTIME_DEBUG)
                    console.log(
                      JSON.stringify({
                        model,
                        runtime_request: runtimeRequests,
                        path: new URL(request.url).pathname,
                        streaming: body.stream,
                      }),
                    );
                }
                return send(request, context);
              };
              super(options);
            }
            async createSession(options) {
              sessions.push({
                model: options.model,
                contextTier: options.contextTier,
                reasoningEffort: options.reasoningEffort,
                streaming: options.streaming,
              });
              const session = await super.createSession(options);
              sessionIds.push(session.sessionId);
              session.on((event) => {
                if (event.type === "session.error")
                  errors.push(event.data.errorType);
                if (event.type === "session.idle") idle++;
              });
              return session;
            }
            async deleteSession(id) {
              assert.ok(sessionIds.includes(id));
              await access(join(homedir(), ".copilot", "session-state", id));
              await super.deleteSession(id);
              deletedSessionIds.push(id);
            }
          }
          sdk = await createSdkTransport({
            Client,
            cliPath,
            directory: root,
            environment: { ...process.env, COPILOT_AUTO_UPDATE: "false" },
            forward: async (request) => {
              if (request.method === "GET") return fetch(request);
              backendRequests++;
              const messages = new URL(request.url).pathname === "/v1/messages";
              const id = "synthetic-runtime-check",
                marker = "SDK_RUNTIME_LONG_OK";
              return new Response(
                new ReadableStream({
                  start(controller) {
                    let ended = false;
                    const emit = (event) => controller.enqueue(encode(event));
                    const clear = () => {
                      clearInterval(progress);
                      clearTimeout(end);
                      request.signal.removeEventListener("abort", abort);
                    };
                    const abort = () => {
                      if (ended) return;
                      ended = true;
                      clear();
                      controller.error(
                        new Error("Synthetic inference cancelled."),
                      );
                    };
                    const progress = setInterval(
                      () =>
                        emit(
                          messages
                            ? {
                                type: "content_block_delta",
                                index: 0,
                                delta: {
                                  type: "thinking_delta",
                                  thinking: ".",
                                },
                              }
                            : {
                                type: "response.in_progress",
                                response: { id, status: "in_progress" },
                              },
                        ),
                      Math.min(10000, duration / 4),
                    );
                    const end = setTimeout(() => {
                      if (ended) return;
                      ended = true;
                      clear();
                      if (messages) {
                        emit({
                          type: "content_block_delta",
                          index: 0,
                          delta: {
                            type: "signature_delta",
                            signature: "synthetic-signature",
                          },
                        });
                        emit({ type: "content_block_stop", index: 0 });
                        emit({
                          type: "content_block_start",
                          index: 1,
                          content_block: { type: "text", text: marker },
                        });
                        emit({ type: "content_block_stop", index: 1 });
                        emit({
                          type: "message_delta",
                          delta: { stop_reason: "end_turn" },
                          usage: { output_tokens: 0 },
                          copilot_usage: { total_nano_aiu: 0 },
                        });
                        emit({ type: "message_stop" });
                      } else {
                        const item = {
                          type: "message",
                          id: "answer",
                          role: "assistant",
                          content: [
                            {
                              type: "output_text",
                              text: marker,
                              annotations: [],
                            },
                          ],
                        };
                        emit({ type: "response.output_item.done", item });
                        emit({
                          type: "response.completed",
                          response: {
                            id,
                            status: "completed",
                            output: [item],
                            usage: {
                              input_tokens: 0,
                              output_tokens: 0,
                              total_tokens: 0,
                            },
                          },
                          copilot_usage: { total_nano_aiu: 0 },
                        });
                      }
                      controller.close();
                    }, duration);
                    request.signal.addEventListener("abort", abort, {
                      once: true,
                    });
                    if (request.signal.aborted) abort();
                    else if (messages) {
                      emit({
                        type: "message_start",
                        message: {
                          id,
                          type: "message",
                          role: "assistant",
                          model,
                          content: [],
                          usage: { input_tokens: 0, output_tokens: 0 },
                        },
                      });
                      emit({
                        type: "content_block_start",
                        index: 0,
                        content_block: {
                          type: "thinking",
                          thinking: "",
                          signature: "",
                        },
                      });
                    } else
                      emit({
                        type: "response.created",
                        response: { id, status: "in_progress", output: [] },
                      });
                  },
                }),
                { headers: { "content-type": "text/event-stream" } },
              );
            },
          });
          const selected = (
            await listModels(async () => "sdk-owned", sdk.transport, {
              messages: true,
            })
          ).find((entry) => entry.id === model);
          assert.ok(
            selected,
            "The logged-in seat must enable the selected model.",
          );
          bridge = await startBridge({
            getToken: async () => "sdk-owned",
            localToken: "local",
            model,
            transport: sdk.transport,
          });
          const invocation = codexInvocation({
            model,
            url: bridge.url,
            localToken: "local",
            stateDir: state,
            args: [
              ...(await modelArguments(
                selected,
                "max",
                join(root, "models.json"),
              )),
              "--yolo",
              "exec",
              "--skip-git-repo-check",
              "--json",
              "Run the synthetic stream lifetime check.",
            ],
          });
          const pending = promisify(execFile)(codexBin, invocation.args, {
            cwd: root,
            env: invocation.env,
            timeout: duration + 45000,
            maxBuffer: 1024 * 1024,
          });
          pending.child.stdin.end();
          const output = await pending;
          await sdk.close();
          assert.match(output.stdout, /SDK_RUNTIME_LONG_OK/);
          assert.doesNotMatch(
            output.stdout + output.stderr,
            /Reconnecting|stream ended|stream disconnected/i,
          );
          assert.equal(backendRequests, 1);
          assert.equal(runtimeRequests, 1);
          assert.ok(
            idle >= 1,
            "Runtime must accept the acknowledgement before shutdown.",
          );
          assert.deepEqual(errors, []);
          assert.deepEqual(deletedSessionIds, sessionIds);
          for (const id of sessionIds)
            await assert.rejects(
              access(join(homedir(), ".copilot", "session-state", id)),
              { code: "ENOENT" },
              "Temporary SDK state must be removed after accounting completes.",
            );
          assert.deepEqual(sessions, [
            {
              model,
              contextTier: "long_context",
              reasoningEffort: "max",
              streaming: true,
            },
          ]);
        }),
      ),
    );
  },
);
