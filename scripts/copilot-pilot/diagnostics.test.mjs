import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendDiagnostic } from "./diagnostics.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "copilot-log-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return join(root, "diagnostics.jsonl");
}

test("a full diagnostic log rotates and records the new failure", (t) => {
  const file = fixture(t);
  const previous = " ".repeat(1024 * 1024);
  writeFileSync(file, previous, { mode: 0o600 });
  writeFileSync(file + ".1", "earlier");
  writeFileSync(file + ".2", "oldest retained");
  writeFileSync(file + ".3", "expired");
  appendDiagnostic(file, { code: "UPSTREAM_TERMINAL_EVENT" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).code, "UPSTREAM_TERMINAL_EVENT");
  assert.equal(readFileSync(file + ".1", "utf8"), previous);
  assert.equal(readFileSync(file + ".2", "utf8"), "earlier");
  assert.equal(readFileSync(file + ".3", "utf8"), "oldest retained");
  assert.equal(existsSync(file + ".rotate-lock"), false);
  assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("rotation defers on a live lock and recovers a stale lock", (t) => {
  const file = fixture(t);
  writeFileSync(file, " ".repeat(1024 * 1024));
  writeFileSync(file + ".rotate-lock", "");
  appendDiagnostic(file, { code: "deferred" });
  assert.equal(existsSync(file + ".1"), false);
  const earlier = new Date(Date.now() - 60000);
  utimesSync(file + ".rotate-lock", earlier, earlier);
  appendDiagnostic(file, { code: "recovered" });
  assert.equal(JSON.parse(readFileSync(file, "utf8")).code, "recovered");
  assert.equal(existsSync(file + ".rotate-lock"), false);
});

test("unavailable diagnostics never replace an inference result", () => {
  assert.doesNotThrow(() => appendDiagnostic(undefined, { code: "ignored" }));
  assert.doesNotThrow(() => appendDiagnostic("/proc/no-log-here", { code: "ignored" }));
  assert.doesNotThrow(() => appendDiagnostic("/proc/self/stat", { code: "ignored" }));
});
