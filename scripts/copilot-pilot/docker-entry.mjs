import { createConnection, createServer } from "node:net";
import { spawn } from "node:child_process";

// The container has no IP network. Only this private, authenticated model
// connection crosses to the host; no GitHub credentials enter the container.
const sockets = new Set();
const server = createServer((socket) => {
  const upstream = createConnection("/transport/bridge.sock");
  for (const stream of [socket, upstream]) {
    sockets.add(stream);
    stream.on("close", () => sockets.delete(stream));
    stream.on("error", () => {
      socket.destroy();
      upstream.destroy();
    });
  }
  socket.pipe(upstream).pipe(socket);
});
server.listen(8787, "127.0.0.1", () => {
  const child = spawn("/opt/codex/bin/codex", process.argv.slice(2), {
    stdio: "inherit",
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
  child.on("error", () => {
    console.error("Cannot start container Codex.");
    process.exitCode = 1;
    server.close();
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 1;
    for (const socket of sockets) socket.destroy();
    server.close();
  });
});
