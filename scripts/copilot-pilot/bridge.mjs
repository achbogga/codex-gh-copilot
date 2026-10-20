import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { usesMessages } from "./anthropic-request.mjs";
import { encryptedAgentError } from "./agent-messages.mjs";

const upstream = "https://api.githubcopilot.com";
// Copilot CLI 1.0.74 raised the CAPI Responses request ceiling to 32 MiB.
// Byte limits are separate from model token limits, especially with encrypted
// reasoning in long sessions. Keep model discovery's smaller bound independent.
const maxRequestBody = 32 * 1024 * 1024;
const maxCatalogBody = 8 * 1024 * 1024;

function fail(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({ error: { message, type: "copilot_pilot_error" } }),
  );
}

function failedEvent(message, code = "stream_interrupted") {
  return `\n\nevent: response.failed\ndata: ${JSON.stringify({ type: "response.failed", response: { status: "failed", error: { type: "copilot_pilot_error", code, message } } })}\n\n`;
}

function failContextLimit(response, message) {
  // A raw 413 is an unknown HTTP error to Codex and leaves token accounting
  // below the compaction threshold. This explicit failure marks context full,
  // so native local compaction can run on the next turn, without stream retries.
  response.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    "connection": "close",
  });
  response.end(failedEvent(message, "context_length_exceeded"));
}

function headers(token) {
  if (!token || /\s/.test(token)) throw new Error("Invalid credential.");
  return {
    "Authorization": `Bearer ${token}`,
    "User-Agent": "codex-copilot-pilot/0.1",
    "X-GitHub-Api-Version": "2026-06-01",
  };
}

async function readBounded(stream, limit, destroyOnReturn = true) {
  const chunks = [];
  let size = 0;
  // Breaking an IncomingMessage's default iterator destroys its socket before
  // we can return the classified size error for chunked uploads.
  for await (const chunk of stream.iterator({ destroyOnReturn })) {
    size += chunk.length;
    if (size > limit)
      throw Object.assign(new Error("Body exceeds pilot limit."), {
        code: "PILOT_BODY_TOO_LARGE",
      });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The injected transport is for local tests. Production has one fixed TLS origin.
export async function listModels(
  getToken,
  transport = fetch,
  { messages = false, runtimeModelIds = [] } = {},
) {
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
    await readBounded(Readable.fromWeb(response.body), maxCatalogBody),
  );
  if (!Array.isArray(catalog.data)) throw new Error("Invalid model catalog.");
  return catalog.data.filter(
    (model) =>
      typeof model?.id === "string" &&
      model.model_picker_enabled === true &&
      (model.policy?.state === "enabled" ||
        (!model.policy && runtimeModelIds.includes(model.id))) &&
      (model.supported_endpoints?.includes("/responses") ||
        (messages && usesMessages(model))) &&
      model.capabilities?.supports?.tool_calls === true &&
      model.capabilities?.supports?.streaming === true,
  );
}

export async function startBridge({
  getToken,
  localToken,
  model,
  models = [model],
  transport = fetch,
  socketPath,
  streamIdleTimeoutMs = 300000,
}) {
  const expected = Buffer.from(`Bearer ${localToken}`);
  const allowedModels = new Set(
    models.map((entry) => (typeof entry === "string" ? entry : entry.id)),
  );
  const active = new Set();
  const server = createServer(async (request, response) => {
    const controller = new AbortController();
    active.add(controller);
    // A long, active max-reasoning response must not hit a total-duration cap.
    const timer = setTimeout(() => controller.abort(), streamIdleTimeoutMs);
    const activity = () => {
      if (!controller.signal.aborted) timer.refresh();
    };
    response.on("close", () => {
      if (!response.writableFinished) controller.abort();
    });
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
      if (Number(request.headers["content-length"]) > maxRequestBody) {
        return failContextLimit(
          response,
          "Request exceeds Copilot's 32 MiB request limit. Compact the conversation before continuing.",
        );
      }
      const body = await readBounded(request, maxRequestBody, false);
      const payload = JSON.parse(body);
      if (
        !allowedModels.has(payload?.model) ||
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
        // SDK transport also reports raw Anthropic activity before translation.
        onActivity: activity,
      });
      activity();
      if (!result.ok) {
        const retryAfter = result.headers.get("retry-after");
        if (retryAfter) response.setHeader("retry-after", retryAfter);
        await result.body?.cancel();
        // Upstream error bodies can echo request data or credentials. Never relay them.
        const status = result.status >= 400 ? result.status : 502;
        if (status === 413)
          return failContextLimit(
            response,
            "Copilot rejected the request as too large (HTTP 413). Compact the conversation before continuing.",
          );
        const message = `Copilot returned HTTP ${result.status}; check authentication, policy, model compatibility, or budget.`;
        if (status >= 400 && status < 500) {
          // Native Codex retries unknown HTTP statuses. Encode an explicit
          // terminal rejection so enabling stream recovery cannot retry denial.
          response.writeHead(200, {
            "content-type": "text/event-stream",
            "cache-control": "no-store",
          });
          return response.end(
            failedEvent(
              message + " This rejection is not retried.",
              "invalid_prompt",
            ),
          );
        }
        return fail(response, status, message);
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
      async function* stream() {
        try {
          for await (const chunk of Readable.fromWeb(result.body, {
            signal: controller.signal,
          })) {
            activity();
            yield chunk;
          }
        } catch (error) {
          // Report a real failure, never fabricate response.completed or replay
          // a partially executed tool call. Suppress upstream error payloads.
          if (!response.destroyed) {
            if (error.code === "COPILOT_ENCRYPTED_AGENT_MESSAGE") {
              yield Buffer.from(
                failedEvent(encryptedAgentError, "invalid_prompt"),
              );
              return;
            }
            const message = controller.signal.aborted
              ? `Copilot stream inactive for ${streamIdleTimeoutMs} ms.`
              : `Copilot stream ended before completion${["COPILOT_UNEXPECTED_EOF", "UND_ERR_SOCKET", "UND_ERR_BODY_TIMEOUT", "ECONNRESET", "ETIMEDOUT", "ABORT_ERR", "INVALID_SSE_JSON", "STREAM_READ_ERROR"].includes(error.code) ? ` (${error.code})` : ""}.`;
            yield Buffer.from(failedEvent(message));
          }
        }
      }
      await pipeline(Readable.from(stream()), response);
    } catch (error) {
      if (response.headersSent) response.destroy();
      else if (
        !response.destroyed &&
        error.code === "COPILOT_ENCRYPTED_AGENT_MESSAGE"
      ) {
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
        });
        response.end(failedEvent(encryptedAgentError, "invalid_prompt"));
      } else if (!response.destroyed && error.code === "PILOT_BODY_TOO_LARGE")
        failContextLimit(
          response,
          "Request exceeds Copilot's 32 MiB request limit. Compact the conversation before continuing.",
        );
      else if (!response.destroyed)
        fail(
          response,
          502,
          controller.signal.aborted
            ? `Copilot request inactive for ${streamIdleTimeoutMs} ms.`
            : "Pilot request failed; check credentials, JSON, size, TLS, and connectivity.",
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
