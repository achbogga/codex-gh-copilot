import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { recall } from "./efficiency/observations.mjs";
import { runObserved } from "./efficiency/run.mjs";
import {
  efficiencyArguments,
  efficiencyCommand,
  manageEfficiency,
} from "./efficiency/config.mjs";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "codex-sol-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const command = (code) => `${quote(process.execPath)} -e ${quote(code)}`;

test("large failed logs keep status, exact middle evidence, stable archives and paged UTF-8 recall", async (t) => {
  const root = await fixture(t);
  const text =
    Array.from({ length: 2000 }, (_, i) =>
      i === 1023
        ? "ERROR: rare failure hidden in the middle café ✅"
        : `${i}: routine diagnostic ${"x".repeat(50)}`,
    ).join("\n") + "\n";
  const source = join(root, "source.log");
  await writeFile(source, text);
  const args = {
    workdir: root,
    command: command(
      `process.stdout.write(require('fs').readFileSync(${JSON.stringify(source)}));process.exitCode=7`,
    ),
  };
  const result = await runObserved(join(root, "archive"), args);
  assert.equal(result.exit_code, 7);
  assert.equal(result.complete, true);
  assert.equal(result.packed, true);
  assert.match(
    result.excerpts,
    /ERROR: rare failure hidden in the middle café ✅/,
  );
  assert.equal(await readFile(result.archive_path, "utf8"), text);
  assert.equal(result.archive, createHash("sha256").update(text).digest("hex"));
  assert.ok(
    Buffer.byteLength(JSON.stringify(result)) < Buffer.byteLength(text) * 0.1,
  );
  const match = await recall(join(root, "archive"), {
    archive: result.archive,
    contains: "café ✅",
    limit: 64,
  });
  assert.match(match.text, /café ✅/);
  let reconstructed = "",
    offset = 0;
  while (offset < Buffer.byteLength(text)) {
    const page = await recall(join(root, "archive"), {
      archive: result.archive,
      offset,
      limit: 1021,
    });
    assert.ok(page.next_offset > offset);
    reconstructed += page.text;
    offset = page.next_offset;
  }
  assert.equal(reconstructed, text);
  assert.equal(
    (await runObserved(join(root, "archive"), args)).archive,
    result.archive,
  );
  if (process.platform !== "win32")
    assert.equal((await stat(result.archive_path)).mode & 0o777, 0o600);
});

test("small outputs stay whole; timeout and cancellation cannot claim success", async (t) => {
  const root = await fixture(t),
    archive = join(root, "archive");
  const small = await runObserved(archive, {
    workdir: root,
    command: command("console.log('exact small output')"),
  });
  assert.equal(small.output, "exact small output\n");
  assert.equal(small.packed, false);
  const timeout = await runObserved(archive, {
    workdir: root,
    command: command("console.log('started');setTimeout(()=>{},10000)"),
    timeout_ms: 200,
  });
  assert.equal(timeout.complete, false);
  assert.equal(timeout.interrupted, "timeout");
  assert.notEqual(timeout.exit_code, 0);
  const controller = new AbortController();
  const running = runObserved(
    archive,
    { workdir: root, command: command("setTimeout(()=>{},10000)") },
    controller.signal,
  );
  setTimeout(() => controller.abort(), 100);
  const cancelled = await running;
  assert.equal(cancelled.complete, false);
  assert.equal(cancelled.interrupted, "cancelled");
  if (process.platform !== "win32") {
    const background = await runObserved(archive, {
      workdir: root,
      command: "sleep 10 &",
      timeout_ms: 100,
    });
    assert.equal(background.complete, false);
    assert.equal(background.interrupted, "timeout");
  }
});

test("recall rejects traversal, tampering and symlinks; storage failure prevents command execution", async (t) => {
  const root = await fixture(t),
    archive = join(root, "archive");
  const result = await runObserved(archive, {
    workdir: root,
    command: "printf original",
  });
  await assert.rejects(
    recall(archive, { archive: "../../secret" }),
    /Invalid archive/,
  );
  await writeFile(result.archive_path, "changed");
  await assert.rejects(
    recall(archive, { archive: result.archive }),
    /integrity/,
  );
  if (process.platform !== "win32") {
    const linked = join(root, "linked");
    await symlink(archive, linked);
    await assert.rejects(
      runObserved(linked, { workdir: root, command: "touch must-not-exist" }),
      /real directory/,
    );
    await assert.rejects(stat(join(root, "must-not-exist")), {
      code: "ENOENT",
    });
  }
});

test("efficiency opt-in, alias routing, container paths and statistics include recall overhead", async (t) => {
  const root = await fixture(t);
  assert.deepEqual(await efficiencyArguments(root), []);
  assert.deepEqual(efficiencyCommand(["--yolo", "efficiency", "on"]), ["on"]);
  assert.equal(efficiencyCommand(["exec", "efficiency"]), null);
  assert.equal((await manageEfficiency(root, ["on"])).enabled, true);
  const args = await efficiencyArguments(root, {
    node: "node",
    server: "/opt/efficiency/server.mjs",
    visibleState: "/codex-home",
    environmentKeys: ["FAKE_TEST_TOKEN"],
  });
  assert.match(args[1], /\/codex-home\/efficiency-archives/);
  assert.match(args[1], /env_vars=\["FAKE_TEST_TOKEN"\]/);
  const result = await runObserved(join(root, "efficiency-archives"), {
    workdir: root,
    command: command("console.log('log line\\n'.repeat(4000))"),
  });
  await recall(join(root, "efficiency-archives"), { archive: result.archive });
  const stats = await manageEfficiency(root, ["status"]);
  assert.equal(stats.runs, 1);
  assert.equal(stats.packed_logs, 1);
  assert.ok(stats.recall_bytes > 0);
  assert.equal(
    stats.net_output_bytes_avoided,
    stats.source_bytes - stats.returned_bytes - stats.recall_bytes,
  );
  await manageEfficiency(root, ["off"]);
  assert.deepEqual(await efficiencyArguments(root), []);
});

test("MCP stdio initializes, executes a failing command, recalls evidence and closes cleanly", async (t) => {
  const root = await fixture(t);
  const child = spawn(
    process.execPath,
    [new URL("./efficiency/server.mjs", import.meta.url).pathname, root],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  const waiting = new Map();
  let id = 0,
    stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    const value = JSON.parse(line);
    waiting.get(value.id)?.(value);
    waiting.delete(value.id);
  });
  const rpc = (method, params) =>
    new Promise((resolve) => {
      const current = ++id;
      waiting.set(current, resolve);
      child.stdin.write(
        JSON.stringify({ jsonrpc: "2.0", id: current, method, params }) + "\n",
      );
    });
  t.after(() => child.kill());
  assert.equal(
    (await rpc("initialize", { protocolVersion: "2024-11-05" })).result
      .serverInfo.name,
    "codex-sol-efficiency",
  );
  assert.deepEqual(
    (await rpc("tools/list", {})).result.tools.map((tool) => tool.name),
    ["run", "recall"],
  );
  const failed = await rpc("tools/call", {
    name: "run",
    arguments: {
      command: "printf 'ERROR exact evidence'; exit 9",
      workdir: root,
    },
  });
  assert.equal(failed.result.isError, true);
  const receipt = JSON.parse(failed.result.content[0].text);
  const page = await rpc("tools/call", {
    name: "recall",
    arguments: { archive: receipt.archive },
  });
  assert.equal(
    JSON.parse(page.result.content[0].text).text,
    "ERROR exact evidence",
  );
  const exit = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  assert.equal(await exit, 0);
  assert.equal(stderr, "");
});
