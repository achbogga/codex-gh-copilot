import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Recognize both `codex-copilot update` and the existing `cxf` alias's
// `codex-copilot -- --yolo update`, before starting either coding runtime.
export function updateArguments(args) {
  let offset = 0;
  while (
    ["--yolo", "--dangerously-bypass-approvals-and-sandbox"].includes(
      args[offset],
    )
  )
    offset++;
  return args[offset] === "update" ? args.slice(offset + 1) : null;
}

export async function runUpdate(args) {
  const all = !args.length || args.includes("--all");
  const child = spawn(
    "python3",
    [
      fileURLToPath(
        new URL(all ? "./update_all.py" : "./update_check.py", import.meta.url),
      ),
      "--config",
      join(homedir(), ".codex-copilot-pilot", "update-config.json"),
      ...(all ? args.filter((arg) => arg !== "--all") : args),
    ],
    { stdio: "inherit" },
  );
  return await new Promise((done, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      done(code ?? (signal === "SIGINT" ? 130 : 143)),
    );
  });
}
