import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recall } from "./observations.mjs";
import { runObserved } from "./run.mjs";

// Deterministic observation benchmark, not a model-quality or billing benchmark.
const root = await mkdtemp(join(tmpdir(), "codex-sol-bench-"));
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const rows = [];
try {
  for (const [name, special, status, focus] of [
    ["passing tests", "tests passed: 3000", 0],
    ["middle failure", "ERROR assertion: expected 7, received 9", 1],
    ["literal target", "MIDDLE_TOKEN=violet-719-copper", 0, "MIDDLE_TOKEN"],
  ]) {
    const text =
      Array.from({ length: 3000 }, (_, i) =>
        i === 1427 ? special : `${i}: routine log output ${"x".repeat(60)}`,
      ).join("\n") + "\n";
    const source = join(root, "source.log");
    await writeFile(source, text);
    const script = `process.stdout.write(require('fs').readFileSync(${JSON.stringify(source)}));process.exitCode=${status}`;
    const result = await runObserved(join(root, "archive"), {
      command: `${quote(process.execPath)} -e ${quote(script)}`,
      workdir: root,
      focus,
    });
    assert.equal(result.exit_code, status);
    assert.equal(await readFile(result.archive_path, "utf8"), text);
    assert.ok(result.excerpts.includes(special));
    const recalled = await recall(join(root, "archive"), {
      archive: result.archive,
      contains: special,
      limit: 512,
    });
    assert.ok(recalled.text.includes(special));
    const sourceBytes = Buffer.byteLength(text),
      receiptBytes = Buffer.byteLength(JSON.stringify(result)),
      recallBytes = Buffer.byteLength(JSON.stringify(recalled));
    rows.push({
      scenario: name,
      source_bytes: sourceBytes,
      receipt_bytes: receiptBytes,
      recall_bytes: recallBytes,
      reduction_with_recall_percent: Number(
        (100 * (1 - (receiptBytes + recallBytes) / sourceBytes)).toFixed(2),
      ),
      exit_code: status,
      exact_archive_verified: true,
    });
  }
  console.log(
    JSON.stringify(
      {
        scope:
          "Synthetic tool-output bytes, including one exact recall; excludes model prompts, reasoning, cache pricing and native Codex truncation. No model calls.",
        rows,
      },
      null,
      2,
    ),
  );
} finally {
  await rm(root, { recursive: true, force: true });
}
