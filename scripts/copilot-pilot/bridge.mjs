import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const upstream = "https://api.githubcopilot.com";
const maxBody = 8 * 1024 * 1024;

function fail(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ error: { message, type: "copilot_pilot_error" } }),
  );
}

function headers(token) {
  if (!token || /\s/.test(token)) throw new Error("Invalid credential.");
  return {
    "Authorization": `Bearer ${token}`,
    "User-Agent": "codex-copilot-pilot/0.1",
    "X-GitHub-Api-Version": "2026-06-01",
  };
}

async function readBounded(stream) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > maxBody) throw new Error("Body exceeds pilot limit.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The injected transport is for local tests. Production has one fixed TLS origin.
export async function listModels(getToken, transport = fetch) {
  const response = await transport(`${upstream}/models`, {
    headers: headers(await getToken()),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      `Copilot model discovery returned HTTP ${response.status}.`,
    );
  }
  const catalog = JSON.parse(
    await readBounded(Readable.fromWeb(response.body)),
  );
  if (!Array.isArray(catalog.data)) throw new Error("Invalid model catalog.");
  return catalog.data.filter(
    (model) =>
      typeof model?.id === "string" &&
      model.model_picker_enabled === true &&
      model.policy?.state === "enabled" &&
      model.supported_endpoints?.includes("/responses") &&
      model.capabilities?.supports?.tool_calls === true &&
      model.capabilities?.supports?.streaming === true,
  );
}

export async function startBridge({
  getToken,
  localToken,
  model,
  transport = fetch,
  socketPath,
}) {
  const expected = Buffer.from(`Bearer ${localToken}`);
  const active = new Set();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(() => controller.abort(), 300000);
    response.on("close", () => controller.abort());
    try {
      const received = Buffer.from(request.headers.authorization ?? "");
      if (
        received.length !== expected.length ||
        !timingSafeEqual(received, expected) ||
        request.headers.origin ||
        request.headers.host !==
          `127.0.0.1:${socketPath ? 8787 : server.address().port}`
      )
        return fail(response, 401, "Local adapter authentication failed.");
      if (request.method !== "POST" || request.url !== "/v1/responses") {
        return fail(response, 404, "Only POST /v1/responses is supported.");
      }
      if (
        request.headers["content-encoding"] ||
        !request.headers["content-type"]?.startsWith("application/json")
      )
        return fail(response, 415, "Expected uncompressed JSON.");
      if (Number(request.headers["content-length"]) > maxBody) {
        return fail(response, 413, "Request exceeds the 8 MiB pilot limit.");
      }
      const body = await readBounded(request);
      const payload = JSON.parse(body);
      if (
        payload?.model !== model ||
        payload.stream !== true ||
        !(Array.isArray(payload.input) || typeof payload.input === "string")
      )
        return fail(
          response,
          400,
          "Expected the selected model, input, and stream=true.",
        );
      const last = Array.isArray(payload.input) ? payload.input.at(-1) : null;
      const initiator =
        typeof payload.input === "string" || last?.role === "user"
          ? "user"
          : "agent";
      const vision =
        Array.isArray(payload.input) &&
        payload.input.some(
          (item) =>
            Array.isArray(item?.content) &&
            item.content.some((part) => part.type === "input_image"),
        );
      const result = await transport(`${upstream}/responses`, {
        method: "POST",
        headers: {
          ...headers(await getToken()),
          "Content-Type": "application/json",
          "Accept": "text/event-stream",
          "Openai-Intent": "conversation-edits",
          "X-Initiator": initiator,
          ...(vision ? { "Copilot-Vision-Request": "true" } : {}),
        },
        body,
        redirect: "error",
        signal: controller.signal,
      });
      if (!result.ok) {
        await result.body?.cancel();
        // Upstream error bodies can echo request data or credentials. Never relay them.
        const status = result.status >= 400 ? result.status : 502;
        return fail(
          response,
          status,
          `Copilot returned HTTP ${result.status}; check authentication, policy, model compatibility, or budget. No automatic retry.`,
        );
      }
      if (
        !result.headers.get("content-type")?.startsWith("text/event-stream")
      ) {
        await result.body?.cancel();
        return fail(response, 502, "Expected a Responses event stream.");
      }
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      response.flushHeaders();
      await pipeline(Readable.fromWeb(result.body), response, {
        signal: controller.signal,
      });
    } catch {
      if (response.headersSent) response.destroy();
      else if (!response.destroyed)
        fail(
          response,
          502,
          "Pilot request failed; check credentials, JSON, size, TLS, and connectivity.",
        );
    } finally {
      clearTimeout(timer);
      active.delete(controller);
    }
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    if (socketPath) server.listen(socketPath, resolve);
    else server.listen(0, "127.0.0.1", resolve);
  });
  return {
    url: `http://127.0.0.1:${socketPath ? 8787 : server.address().port}/v1`,
    close: async () => {
      for (const controller of active) controller.abort();
      await new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      });
    },
  };
}
