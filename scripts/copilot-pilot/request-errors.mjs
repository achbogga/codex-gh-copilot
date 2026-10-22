// Public errors and diagnostics contain only fixed descriptions and allowlisted
// codes. Runtime/fetch error messages can contain credentials or request data.
const network = [
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
];
const tls = [
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
];
const local = ["ENOSPC", "EDQUOT", "EACCES", "EPERM", "EMFILE", "ENFILE"];
const descriptions = {
  COPILOT_BRIDGE_FAILED:
    "The local Copilot bridge failed before returning a response. Check stream-diagnostics.jsonl for the classified failure.",
  COPILOT_INVALID_JSON: "The local request is not valid JSON.",
  COPILOT_ENCRYPTED_AGENT_MESSAGE:
    "The session contains encrypted agent task instructions this adapter cannot decrypt.",
  PILOT_BODY_TOO_LARGE:
    "The native request exceeds Copilot's 32 MiB byte limit.",
  COPILOT_INVALID_HISTORY:
    "The selected Copilot protocol cannot represent part of this request's history or tools. The original session is preserved.",
  COPILOT_MODEL_UNAVAILABLE:
    "The selected model is not advertised by your Copilot seat. Restart cxf to refresh the model catalog.",
  COPILOT_REASONING_UNSUPPORTED:
    "The selected Copilot model does not support the requested reasoning effort.",
  COPILOT_RUNTIME_ORIGIN:
    "The Copilot runtime requested an unapproved API origin. The request was blocked.",
  COPILOT_RUNTIME_SESSION:
    "The Copilot runtime requested inference outside its assigned transport session. The request was blocked.",
  COPILOT_RUNTIME_ENDPOINT:
    "The Copilot runtime requested an unexpected inference endpoint. Update and restart cxf; the request was blocked.",
  COPILOT_RUNTIME_EXTRA_REQUEST:
    "The Copilot runtime tried to repeat inference inside one native request. The additional request was blocked; only native Codex controls retries.",
  COPILOT_RUNTIME_CONTENT_TYPE:
    "Copilot returned an unexpected response format instead of an event stream.",
  COPILOT_SDK_CREATE_FAILED:
    "Copilot could not create its transport session. Check stream-diagnostics.jsonl, then restart cxf if its runtime has stopped.",
  COPILOT_SDK_SEND_FAILED:
    "Copilot could not submit the transport request. Check stream-diagnostics.jsonl, then restart cxf if its runtime has stopped.",
  COPILOT_SDK_QUERY_FAILED:
    "Copilot's runtime failed before returning inference. Check stream-diagnostics.jsonl for its classified failure.",
  COPILOT_SDK_AUTHENTICATION:
    "Copilot authentication failed. Run copilot login, then restart cxf.",
  COPILOT_SDK_RATE_LIMIT: "Copilot's runtime reported a rate limit.",
  COPILOT_SDK_QUOTA: "Copilot's runtime reported an exhausted quota.",
  COPILOT_SDK_CONNECTION:
    "Copilot's runtime lost its connection before returning a response.",
  COPILOT_SDK_TIMEOUT:
    "Copilot's runtime timed out before returning a response.",
  COPILOT_FORWARD_FAILED:
    "Connecting to Copilot failed before response headers arrived.",
  COPILOT_REQUEST_CANCELLED: "The Copilot request was cancelled.",
  COPILOT_NO_RESPONSE:
    "Copilot's runtime finished without returning an inference response.",
};
const transient = new Set([
  ...network,
  "COPILOT_SDK_CONNECTION",
  "COPILOT_SDK_TIMEOUT",
  "COPILOT_FORWARD_FAILED",
]);
const known = new Set([
  ...Object.keys(descriptions),
  ...network,
  ...tls,
  ...local,
]);

// Inspect a small, bounded error body before the SDK tears down its session.
// Cache only fixed classifications so the bridge can reuse the result after
// the original body has been consumed. Never expose upstream free-form text.
const httpFailures = new WeakMap();
export function httpFailure(response) {
  let failure = httpFailures.get(response);
  if (!failure) {
    failure = readHttpFailure(response);
    httpFailures.set(response, failure);
  }
  return failure;
}

async function readHttpFailure(response) {
  const failure = {
    code: "unknown",
    contextExceeded: response.status === 413,
  };
  let reader, timer;
  try {
    if (![400, 422].includes(response.status)) return failure;
    reader = response.body?.getReader();
    if (!reader) return failure;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Error body timeout")), 1000);
    });
    const chunks = [];
    let size = 0;
    while (true) {
      const part = await Promise.race([reader.read(), deadline]);
      if (part.done) break;
      size += part.value.byteLength;
      if (size > 16384) return failure;
      chunks.push(Buffer.from(part.value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const error = body?.error ?? body;
    if (
      ["context_length_exceeded", "invalid_request_body"].includes(error?.code)
    )
      failure.code = error.code;
    failure.contextExceeded =
      error?.code === "context_length_exceeded" ||
      (error?.code === "invalid_request_body" &&
        typeof error.message === "string" &&
        /^Your input exceeds the context window of this model\.(?: Please adjust your input and try again\.)?$/.test(
          error.message,
        ));
    return failure;
  } catch {
    return failure;
  } finally {
    clearTimeout(timer);
    try {
      if (reader) void reader.cancel().catch(() => {});
      else void response.body?.cancel().catch(() => {});
    } catch {} // A broken error body must not replace its original HTTP status.
  }
}

export function requestFailure(error, fallback = "COPILOT_BRIDGE_FAILED") {
  const codes = [];
  for (
    let current = error, n = 0;
    current && n < 4;
    current = current.cause, n++
  )
    codes.push(current.code);
  const code = codes.find((value) => known.has(value)) ?? fallback;
  let message = descriptions[code];
  if (network.includes(code))
    message = `Connecting to Copilot failed before a response (${code}).`;
  if (tls.includes(code))
    message = `Copilot TLS certificate verification failed (${code}). Check the trusted CA configuration; TLS verification remains enabled.`;
  if (local.includes(code))
    message = ["ENOSPC", "EDQUOT"].includes(code)
      ? `Local storage is full (${code}). Free disk space before resuming cxf.`
      : `The local Copilot runtime could not access a required resource (${code}). Check filesystem permissions or open-file limits.`;
  return {
    code,
    message,
    retryable: transient.has(code),
    status: code === "COPILOT_INVALID_JSON" ? 400 : 502,
  };
}

export function requestError(code, cause) {
  const failure = requestFailure({ code });
  return Object.assign(new Error(failure.message, { cause }), {
    code: failure.code,
  });
}

// SDK RPC/session errors often flatten errno into their message. Extract only
// known codes, never copy the runtime's free-form message into logs or replies.
export function runtimeError(error, fallback = "COPILOT_SDK_QUERY_FAILED") {
  const type = {
    authentication: "COPILOT_SDK_AUTHENTICATION",
    rate_limit: "COPILOT_SDK_RATE_LIMIT",
    quota: "COPILOT_SDK_QUOTA",
    connection: "COPILOT_SDK_CONNECTION",
    timeout: "COPILOT_SDK_TIMEOUT",
  }[error?.errorType];
  if (["authentication", "rate_limit", "quota"].includes(error?.errorType))
    return requestError(type, error);
  const structural = requestFailure(error, fallback);
  if (structural.code !== fallback) return requestError(structural.code, error);
  const text = String(error?.message ?? "").slice(0, 4096);
  const code = [...tls, ...local, ...network].find((value) =>
    new RegExp(`\\b${value}\\b`).test(text),
  );
  return requestError(code ?? type ?? fallback, error);
}
