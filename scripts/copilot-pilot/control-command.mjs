import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function controlArguments(args) {
  const commands = args.filter((arg) =>
    !["--yolo", "--dangerously-bypass-approvals-and-sandbox"].includes(arg),
  );
  return ["top", "sessions"].includes(commands[0]) ? commands.slice(1) : null;
}

export function runControl(args, { start = spawn } = {}) {
  const script = fileURLToPath(new URL("../maintenance/control_center.py", import.meta.url));
  return new Promise((resolve, reject) => {
    const child = start("/usr/bin/python3", [script, ...args], { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
