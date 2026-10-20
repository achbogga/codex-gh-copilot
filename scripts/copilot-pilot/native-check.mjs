import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";

// Test client for the installed native harness. It never starts child agents.
export async function nativeCheck({ binary, invocation, cwd, stderrFile }) {
  const child = spawn(binary, invocation.args, {
    cwd,
    env: invocation.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map(),
    turns = new Map();
  let sequence = 0,
    closed = false;
  child.stderr.on("data", (chunk) => {
    if (stderrFile) appendFileSync(stderrFile, chunk, { mode: 0o600 });
  });
  const fail = (error) => {
    for (const waiter of pending.values()) waiter.reject(error);
    for (const waiter of turns.values()) waiter.reject(error);
    pending.clear();
    turns.clear();
  };
  child.on("error", fail);
  child.on("exit", () => {
    closed = true;
    fail(new Error("Native test harness exited."));
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    if (event.id && pending.has(event.id)) {
      const waiter = pending.get(event.id);
      pending.delete(event.id);
      event.error
        ? waiter.reject(new Error(JSON.stringify(event.error)))
        : waiter.resolve(event.result);
      return;
    }
    const waiter = turns.get(event.params?.threadId);
    if (!waiter) return;
    waiter.events.push(event);
    if (event.method === "turn/completed") {
      turns.delete(event.params.threadId);
      waiter.resolve({ turn: event.params.turn, events: waiter.events });
    }
  });
  const rpc = async (method, params, timeout = 180000) => {
    const id = ++sequence;
    let timer;
    try {
      return await Promise.race([
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.stdin.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          );
        }),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Native ${method} timed out.`)),
            timeout,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      pending.delete(id);
    }
  };
  await rpc("initialize", {
    clientInfo: { name: "copilot-model-matrix", version: "1.0.0" },
  });
  child.stdin.write('{"jsonrpc":"2.0","method":"initialized"}\n');
  return {
    rpc,
    turn: async (threadId, model, text, effort, timeout = 180000) => {
      if (turns.has(threadId))
        throw new Error("A test turn is already active.");
      let timer;
      try {
        const done = new Promise((resolve, reject) =>
          turns.set(threadId, { resolve, reject, events: [] }),
        );
        await rpc("turn/start", {
          threadId,
          model,
          ...(effort ? { effort } : {}),
          input: [{ type: "text", text }],
        });
        return await Promise.race([
          done,
          new Promise((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Native model turn timed out.")),
              timeout,
            );
          }),
        ]);
      } finally {
        clearTimeout(timer);
        turns.delete(threadId);
      }
    },
    close: async () => {
      if (closed) return;
      child.stdin.end();
      child.kill("SIGTERM");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
      if (!closed) child.kill("SIGKILL");
    },
  };
}
