import assert from "node:assert/strict";
import test from "node:test";
import { updateArguments } from "./update-command.mjs";

test("update routing supports the installed alias and preserves check flags", () => {
  assert.deepEqual(updateArguments(["update"]), []);
  assert.deepEqual(updateArguments(["--yolo", "update"]), []);
  assert.deepEqual(updateArguments(["--yolo", "update", "--check"]), [
    "--check",
  ]);
  assert.deepEqual(
    updateArguments([
      "--dangerously-bypass-approvals-and-sandbox",
      "update",
      "--show",
    ]),
    ["--show"],
  );
});

test("normal prompts and Codex commands are not intercepted as updates", () => {
  for (const args of [
    [],
    ["--yolo"],
    ["update the tests"],
    ["exec", "update"],
    ["resume", "--last"],
  ])
    assert.equal(updateArguments(args), null);
});
