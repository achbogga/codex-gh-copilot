import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { finishArchive, maxLogBytes, prepareArchive } from "./observations.mjs";

export async function runObserved(
  root,
  { command, workdir, timeout_ms = 60000, focus },
  signal,
) {
  if (typeof command !== "string" || !command.length || command.length > 65536)
    throw new Error("command must be 1..65536 characters.");
  if (typeof workdir !== "string" || !workdir.length)
    throw new Error("An explicit workdir is required.");
  if (
    focus !== undefined &&
    (typeof focus !== "string" || !focus.length || focus.length > 256)
  )
    throw new Error("focus must be 1..256 characters.");
  if (
    !Number.isSafeInteger(timeout_ms) ||
    timeout_ms < 1 ||
    timeout_ms > 120000
  )
    throw new Error(
      "timeout_ms must be 1..120000. Use native exec for longer or interactive work.",
    );
  signal?.throwIfAborted();
  const pending = await prepareArchive(root);
  let reason,
    killTimer,
    bytes = 0,
    spawnError;
  const shell =
    process.platform === "win32"
      ? (process.env.COMSPEC ?? "cmd.exe")
      : "/bin/bash";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", command]
      : ["-lc", command];
  const child = spawn(shell, args, {
    cwd: workdir,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const writer = createWriteStream(pending.path, {
    fd: pending.file.fd,
    autoClose: false,
  });
  const kill = (value) => {
    try {
      if (process.platform === "win32") child.kill(value);
      else if (child.pid) process.kill(-child.pid, value);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  };
  const stop = (why) => {
    if (reason) return;
    reason = why;
    kill("SIGTERM");
    killTimer = setTimeout(() => kill("SIGKILL"), 1000);
  };
  const abort = () => stop("cancelled");
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timeout = setTimeout(() => stop("timeout"), timeout_ms);
  const flushed = new Promise((resolve) => {
    writer.once("finish", resolve);
    writer.once("error", () => {
      stop("archive_error");
      resolve();
    });
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > maxLogBytes) stop("output_limit");
    });
    stream.pipe(writer, { end: false });
  }
  let result;
  try {
    result = await new Promise((resolve) => {
      child.once("error", (error) => {
        spawnError = error.code ?? "spawn_failed";
      });
      child.once("close", (exit_code, signal) =>
        resolve({
          exit_code,
          signal,
          ...(spawnError ? { error: spawnError } : {}),
        }),
      );
    });
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
    // Terminate any children left behind by a timed-out command before returning.
    if (reason) kill("SIGKILL");
    clearTimeout(killTimer);
    writer.end();
    await flushed;
    await pending.file.close();
  }
  result = {
    ...result,
    ...(reason ? { interrupted: reason, complete: false } : { complete: true }),
  };
  try {
    return await finishArchive(root, pending.path, result, focus);
  } catch (error) {
    return {
      ...result,
      archive_error: error.message,
      archive_path: pending.path,
      note: "Command execution has finished or failed to start. Inspect this retained raw log with native shell tools; do not rerun a mutation just to recover its output.",
    };
  }
}
