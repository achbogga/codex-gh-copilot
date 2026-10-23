import assert from "node:assert/strict";
import test from "node:test";
import { hashText, recoverAgentProgress } from "./agent-recovery.mjs";

const author = "/root/audit";
const progress = {
  type: "agent_message",
  id: "progress",
  author,
  recipient: "/root",
  content: [
    {
      type: "input_text",
      text: `Message Type: MESSAGE\nSender: ${author}\nPayload:\n`,
    },
    { type: "encrypted_content", encrypted_content: "opaque-progress" },
  ],
};
const text =
  "Message Type: FINAL_ANSWER\nSender: /root/audit\nPayload:\nVerified final report with its artifact path.";
const report = {
  type: "agent_message",
  id: "final",
  author,
  recipient: "/root",
  content: [{ type: "input_text", text }],
};
const entries = {
  [hashText("opaque-progress")]: {
    author,
    recipient: "/root",
    report_id: "final",
    report_sha256: hashText(text),
  },
};

test("explicit recovery labels unreadable progress and requires the exact native plaintext final report", () => {
  const body = {
    model: "gpt-6.1-sol",
    input: [
      progress,
      report,
      { type: "reasoning", encrypted_content: "private-reasoning" },
    ],
  };
  const original = JSON.stringify(body);
  const recovered = recoverAgentProgress(body, entries);
  assert.match(
    recovered.input[0].content[1].text,
    /does not decrypt or reconstruct/,
  );
  assert.match(recovered.input[0].content[1].text, /message final/);
  assert.equal(recovered.input[1], report);
  assert.equal(recovered.input[2], body.input[2]);
  assert.equal(JSON.stringify(body), original);
  assert.equal(recovered.input[0].id, progress.id);
});

test("missing, altered or differently attributed plaintext cannot authorize recovery", () => {
  for (const final of [
    null,
    { ...report, author: "/root/other" },
    { ...report, content: [{ type: "input_text", text: text + "changed" }] },
    {
      ...report,
      content: [
        { type: "encrypted_content", encrypted_content: "opaque-final" },
      ],
    },
  ]) {
    assert.throws(
      () =>
        recoverAgentProgress(
          { input: [progress, ...(final ? [final] : [])] },
          entries,
        ),
      { code: "COPILOT_ENCRYPTED_AGENT_MESSAGE" },
    );
  }
});

test("unknown ciphertext, absent opt-in, user instructions and encrypted final messages remain untouched", () => {
  const body = { input: [progress, report] };
  assert.equal(recoverAgentProgress(body), body);
  assert.equal(
    recoverAgentProgress(body, {
      unrelated: entries[hashText("opaque-progress")],
    }),
    body,
  );
  for (const protectedItem of [
    { ...progress, author: "/root", recipient: "/root/audit" },
    { ...progress, type: "message", role: "user" },
    {
      ...progress,
      content: [
        { type: "input_text", text: "Message Type: FINAL_ANSWER\n" },
        progress.content[1],
      ],
    },
  ]) {
    const protectedBody = { input: [protectedItem, report] };
    assert.equal(recoverAgentProgress(protectedBody, entries), protectedBody);
  }
});
