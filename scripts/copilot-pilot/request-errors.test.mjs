import assert from "node:assert/strict";
import test from "node:test";
import {
  requestError,
  requestFailure,
  runtimeError,
} from "./request-errors.mjs";

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
