import assert from "node:assert/strict";
import test from "node:test";
import { EventEmitter } from "node:events";
import { controlArguments, runControl } from "./control-command.mjs";

test("top routes to the local dashboard without consuming native prompts", () => {
  assert.deepEqual(controlArguments(["--yolo", "top", "--json"]), ["--json"]);
  assert.deepEqual(controlArguments(["sessions", "--once"]), ["--once"]);
  assert.equal(controlArguments(["resume", "thread-id"]), null);
  assert.equal(controlArguments(["exec", "top"]), null);
});

test("dashboard inherits the terminal and does not launch the Copilot runtime", async () => {
  const started = [];
  const result = runControl(["--once"], {
    start: (...args) => {
      started.push(args);
      const process = new EventEmitter();
      queueMicrotask(() => process.emit("exit", 0));
      return process;
    },
  });
  assert.equal(await result, 0);
  assert.equal(started.length, 1);
  assert.equal(started[0][0], "/usr/bin/python3");
  assert.match(started[0][1][0], /maintenance\/control_center\.py$/);
  assert.deepEqual(started[0][2], { stdio: "inherit" });
});
