import {
  appendFileSync,
  closeSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";

const maxBytes = 1024 * 1024;
const generations = 3;

function remove(file) {
  try {
    unlinkSync(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

// All Screen bridges share this metadata-only log. Bound its disk use without
// permanently disabling diagnostics when a long-running session fills it.
export function appendDiagnostic(file, details) {
  if (!file) return;
  let lock;
  const lockFile = file + ".rotate-lock";
  try {
    let size = 0;
    try {
      size = statSync(file).size;
    } catch (error) {
      if (error.code !== "ENOENT") return;
    }
    if (size >= maxBytes) {
      try {
        lock = openSync(lockFile, "wx", 0o600);
      } catch (error) {
        if (error.code !== "EEXIST") return;
        // Rotation is synchronous and takes milliseconds. Recover a lock left
        // by a crashed writer, without waiting on another live rotation.
        if (Date.now() - statSync(lockFile).mtimeMs < 30000) return;
        remove(lockFile);
        lock = openSync(lockFile, "wx", 0o600);
      }
      for (let index = generations; index >= 1; index--) {
        const source = index === 1 ? file : file + "." + (index - 1);
        try {
          renameSync(source, file + "." + index);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }
    appendFileSync(
      file,
      JSON.stringify({
        time: new Date().toISOString(),
        process_id: process.pid,
        ...details,
      }) + "\n",
      { mode: 0o600 },
    );
  } catch {} // Diagnostic I/O must never interrupt inference.
  finally {
    if (lock !== undefined) {
      try {
        closeSync(lock);
        remove(lockFile);
      } catch {}
    }
  }
}
