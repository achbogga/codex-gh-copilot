import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFile,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";

export const threshold = 10 * 1024;
export const maxLogBytes = 64 * 1024 * 1024;
export const recallMarker = "SOL_EXACT_RECALL_V1";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function prepareArchive(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error("Archive root must be a real directory.");
  let size = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isFile()) size += (await lstat(join(root, entry.name))).size;
  }
  if (size > 512 * 1024 * 1024)
    throw new Error(
      "Observation archive exceeds 512 MiB; move old archives before starting another command.",
    );
  const path = join(root, `pending-${randomUUID()}.log`);
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_EXCL |
      constants.O_WRONLY |
      constants.O_NOFOLLOW,
    0o600,
  );
  return { path, file };
}

async function readObject(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > maxLogBytes + 8 * 1024 * 1024)
      throw new Error("Invalid or oversized archive.");
    return await file.readFile();
  } finally {
    await file.close();
  }
}

// A receipt is an index into evidence, never a semantic summary or a success verdict.
export function excerpt(text, focus) {
  const lines = text.split("\n"),
    selected = new Map();
  const take = (indices, budget) => {
    let bytes = 0;
    for (const i of indices) {
      if (selected.has(i)) continue;
      const line = `${i + 1}: ${lines[i]}`;
      const size = Buffer.byteLength(line) + 1;
      if (size > budget - bytes) continue;
      selected.set(i, line);
      bytes += size;
    }
  };
  take(lines.map((_, i) => i).slice(0, 80), 2048);
  take(
    lines
      .map((_, i) => i)
      .slice(-80)
      .reverse(),
    1536,
  );
  take(
    lines.flatMap((line, i) =>
      (focus && line.includes(focus)) ||
      /\b(error|fail(?:ed|ure)?|warning|exception|panic|fatal|assertion|not ok|tests? passed)\b/i.test(
        line,
      )
        ? [i]
        : [],
    ),
    2048,
  );
  return [...selected]
    .sort(([a], [b]) => a - b)
    .map(([, line]) => line)
    .join("\n");
}

export async function finishArchive(root, pending, result, focus) {
  const bytes = await readObject(pending),
    id = hash(bytes);
  const path = join(root, `${id}.log`);
  try {
    await link(pending, path);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    if (hash(await readObject(path)) !== id)
      throw new Error("Archive integrity check failed.");
  }
  await unlink(pending);
  const text = bytes.toString("utf8");
  const packed = bytes.length > threshold;
  const receipt = {
    ...result,
    archive: id,
    archive_path: path,
    source_bytes: bytes.length,
    packed,
    ...(packed
      ? {
          note: "Partial exact excerpts only. Omitted lines may matter; use recall with this archive and offset/limit or contains before drawing conclusions. Full raw bytes remain on disk.",
          excerpts: excerpt(text, focus),
        }
      : { output: text }),
  };
  const returned = Buffer.byteLength(JSON.stringify(receipt));
  await record(root, {
    type: "run",
    archive: id,
    ...result,
    source_bytes: bytes.length,
    returned_bytes: returned,
    packed,
  });
  return receipt;
}

export async function recall(
  root,
  { archive, offset = 0, limit = 8192, contains },
) {
  if (!/^[a-f0-9]{64}$/.test(archive ?? ""))
    throw new Error("Invalid archive handle.");
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 16384
  )
    throw new Error("Recall uses byte offsets and a limit of 1..16384 bytes.");
  if (
    contains !== undefined &&
    (typeof contains !== "string" || !contains.length || contains.length > 256)
  )
    throw new Error("contains must be 1..256 characters.");
  const bytes = await readObject(join(root, `${archive}.log`));
  if (hash(bytes) !== archive)
    throw new Error("Archive integrity check failed.");
  const found =
    contains === undefined
      ? offset
      : bytes.indexOf(Buffer.from(contains), offset);
  // Expand to UTF-8 boundaries. The on-disk archive retains the original raw bytes.
  let start =
    found < 0
      ? offset
      : Math.max(
          0,
          found -
            (contains === undefined ? 0 : Math.min(512, Math.floor(limit / 4))),
        );
  start = Math.min(start, bytes.length);
  while (start > 0 && (bytes[start] & 0xc0) === 0x80) start--;
  let end = Math.min(bytes.length, start + limit);
  while (end > start && (bytes[end] & 0xc0) === 0x80) end--;
  if (end === start && start < bytes.length)
    end = Math.min(bytes.length, start + 4);
  const result = {
    marker: recallMarker,
    archive,
    source_bytes: bytes.length,
    offset: start,
    next_offset: end,
    eof: end === bytes.length,
    ...(contains === undefined ? {} : { match_offset: found }),
    text:
      found < 0
        ? "No literal match at or after the requested offset."
        : bytes.subarray(start, end).toString("utf8"),
  };
  await record(root, {
    type: "recall",
    returned_bytes: Buffer.byteLength(JSON.stringify(result)),
  });
  return result;
}

export async function record(root, entry) {
  // Statistics failure must not discard the command's evidence or trigger a rerun.
  try {
    await appendFile(
      join(root, "metrics.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n",
      {
        mode: 0o600,
        flag:
          constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_APPEND |
          constants.O_NOFOLLOW,
      },
    );
  } catch {}
}
