import assert from "node:assert/strict";
import test from "node:test";
import {
  httpFailure,
  requestError,
  requestFailure,
  runtimeError,
} from "./request-errors.mjs";

test("Copilot HTTP 400 context overflows survive consumed bodies without exposing provider text", async () => {
  for (const error of [
    { code: "context_length_exceeded", message: "PRIVATE_PROMPT" },
    {
      code: "invalid_request_body",
      message:
        "Your input exceeds the context window of this model. Please adjust your input and try again.",
      private_context: "PRIVATE_PROMPT",
    },
  ]) {
    const response = Response.json({ error }, { status: 400 });
    const failure = await httpFailure(response);
    assert.equal(failure.contextExceeded, true);
    assert.equal(await httpFailure(response), failure);
    assert.equal(response.bodyUsed, true);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_|message/);
  }
});

test("ordinary invalid requests and auth or policy denials never trigger context recovery", async () => {
  for (const [status, error] of [
    [400, { code: "invalid_request_body", message: "PRIVATE_BAD_TOOLS" }],
    [
      400,
      {
        code: "PRIVATE_CODE",
        message: "Your input exceeds the context window of this model.",
      },
    ],
    [403, { code: "context_length_exceeded", message: "PRIVATE_POLICY" }],
    [429, { code: "context_length_exceeded", message: "PRIVATE_BUDGET" }],
  ]) {
    const failure = await httpFailure(Response.json({ error }, { status }));
    assert.equal(failure.contextExceeded, false);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_/);
  }
});

test("unreadable and oversized denial bodies preserve a safe unknown classification", async () => {
  for (const response of [
    new Response("x".repeat(16385), { status: 400 }),
    new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error("PRIVATE_ERROR"));
        },
      }),
      { status: 400 },
    ),
  ]) {
    assert.deepEqual(await httpFailure(response), {
      code: "unknown",
      contextExceeded: false,
    });
  }
});

test("an unfinished error body is cancelled after the inspection deadline", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
    { status: 400 },
  );
  assert.deepEqual(await httpFailure(response), {
    code: "unknown",
    contextExceeded: false,
  });
  assert.equal(cancelled, true);
});

test("network and TLS causes survive wrapped fetch errors without exposing payloads", () => {
  for (const [code, retryable] of [
    ["ECONNRESET", true],
    ["ENOTFOUND", true],
    ["CERT_HAS_EXPIRED", false],
    ["ENOSPC", false],
  ]) {
    const error = new TypeError("fetch failed PRIVATE_PROMPT", {
      cause: Object.assign(new Error("Bearer PRIVATE_TOKEN"), { code }),
    });
    const failure = requestFailure(
      runtimeError(error, "COPILOT_FORWARD_FAILED"),
    );
    assert.equal(failure.code, code);
    assert.equal(failure.retryable, retryable);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_/);
  }
});

test("flattened runtime errno is allowlisted and authentication or budget denials stay terminal", () => {
  assert.equal(
    runtimeError(new Error("RPC failed: ENOSPC PRIVATE_PATH")).code,
    "ENOSPC",
  );
  for (const [errorType, expected] of [
    ["authentication", "COPILOT_SDK_AUTHENTICATION"],
    ["rate_limit", "COPILOT_SDK_RATE_LIMIT"],
    ["quota", "COPILOT_SDK_QUOTA"],
  ]) {
    const failure = requestFailure(
      runtimeError({ errorType, message: "ECONNRESET PRIVATE_TOKEN" }),
    );
    assert.equal(failure.code, expected);
    assert.equal(failure.retryable, false);
    assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_|ECONNRESET/);
  }
});

test("unknown runtime errors fail closed and public classifications never copy free-form fields", () => {
  const error = {
    code: "PRIVATE_CODE",
    message: "PRIVATE_TOKEN",
    errorType: "PRIVATE_TYPE",
    data: { prompt: "PRIVATE_PROMPT" },
  };
  const failure = requestFailure(runtimeError(error));
  assert.equal(failure.code, "COPILOT_SDK_QUERY_FAILED");
  assert.equal(failure.retryable, false);
  assert.doesNotMatch(JSON.stringify(failure), /PRIVATE_/);
  assert.equal(
    requestError("COPILOT_RUNTIME_ENDPOINT", error).code,
    "COPILOT_RUNTIME_ENDPOINT",
  );
});
