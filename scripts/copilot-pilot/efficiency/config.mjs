import { createReadStream } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export async function enabled(state) {
  try {
    const value = JSON.parse(
      await readFile(join(state, "efficiency.json"), "utf8"),
    );
    if (value.version !== 1 || typeof value.enabled !== "boolean")
      throw new Error(
        "Invalid efficiency.json; expected version 1 and enabled boolean.",
      );
    return value.enabled;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

export async function efficiencyArguments(
  state,
  {
    node = process.execPath,
    server = fileURLToPath(new URL("./server.mjs", import.meta.url)),
    visibleState = state,
    environmentKeys = [],
  } = {},
) {
  if (!(await enabled(state))) return [];
  return [
    "-c",
    `mcp_servers.sol_efficiency={command=${JSON.stringify(node)},args=${JSON.stringify([server, join(visibleState, "efficiency-archives")])},env_vars=${JSON.stringify(environmentKeys)},startup_timeout_sec=10,tool_timeout_sec=135,required=true}`,
  ];
}

export function efficiencyCommand(args) {
  let offset = 0;
  while (
    ["--yolo", "--dangerously-bypass-approvals-and-sandbox"].includes(
      args[offset],
    )
  )
    offset++;
  return args[offset] === "efficiency" ? args.slice(offset + 1) : null;
}

export async function manageEfficiency(state, args) {
  const action = args[0] ?? "status";
  if (args.length > 1 || !["on", "off", "status"].includes(action))
    throw new Error("Usage: cxf efficiency [on|off|status]");
  if (action !== "status") {
    await mkdir(state, { recursive: true, mode: 0o700 });
    const temp = join(state, `efficiency-${process.pid}.tmp`);
    await writeFile(
      temp,
      JSON.stringify({ version: 1, enabled: action === "on" }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await rename(temp, join(state, "efficiency.json"));
  }
  const stats = {
    runs: 0,
    packed_logs: 0,
    source_bytes: 0,
    returned_bytes: 0,
    recall_bytes: 0,
  };
  const path = join(state, "efficiency-archives", "metrics.jsonl");
  try {
    // Streaming keeps a long-lived archive's statistics bounded in memory.
    const input = createReadStream(path, { encoding: "utf8" });
    let buffer = "";
    for await (const chunk of input) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop();
      for (const line of lines) {
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type === "run") {
          stats.runs++;
          stats.packed_logs += Number(entry.packed);
          stats.source_bytes += entry.source_bytes;
          stats.returned_bytes += entry.returned_bytes;
        } else if (entry.type === "recall")
          stats.recall_bytes += entry.returned_bytes;
      }
      if (buffer.length > 65536) throw new Error("Invalid metrics line.");
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return {
    enabled: await enabled(state),
    ...stats,
    net_output_bytes_avoided:
      stats.source_bytes - stats.returned_bytes - stats.recall_bytes,
    note: "Local tool-output byte counts, including receipt and recall overhead; not billed tokens or guaranteed API savings. Changes apply to new launches.",
  };
}
