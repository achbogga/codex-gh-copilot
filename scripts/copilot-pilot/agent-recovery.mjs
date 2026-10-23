import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { encryptedAgentError } from "./agent-messages.mjs";

export const hashText = (text) =>
  createHash("sha256").update(text).digest("hex");
const incompatible = () =>
  Object.assign(new Error(encryptedAgentError), {
    code: "COPILOT_ENCRYPTED_AGENT_MESSAGE",
  });

export function loadAgentRecovery(file) {
  if (!file) return {};
  try {
    if (statSync(file).size > 1024 * 1024) throw incompatible();
    const data = JSON.parse(readFileSync(file, "utf8"));
    if (data.version !== 1 || !data.entries || typeof data.entries !== "object")
      throw incompatible();
    return data.entries;
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

// Explicit, reversible recovery for rejected *historical agent progress*, never
// user instructions, signed thinking or tool results. No decryption is attempted.
// The exact plaintext final report must already exist in this same native input.
export function recoverAgentProgress(payload, entries = {}) {
  if (!Array.isArray(payload.input) || !Object.keys(entries).length)
    return payload;
  let changed = false;
  const input = payload.input.map((item) => {
    if (
      item.type !== "agent_message" ||
      item.recipient !== "/root" ||
      item.author === "/root"
    )
      return item;
    const header = item.content
      .filter((part) => part.type === "input_text")
      .map((part) => part.text)
      .join("\n");
    if (!header.startsWith("Message Type: MESSAGE\n")) return item;
    const content = item.content.map((part) => {
      if (part.type !== "encrypted_content") return part;
      const entry = entries[hashText(part.encrypted_content)];
      if (!entry) return part;
      if (entry.author !== item.author || entry.recipient !== item.recipient)
        throw incompatible();
      const report = payload.input.find(
        (candidate) =>
          candidate.type === "agent_message" &&
          candidate.id === entry.report_id &&
          candidate.author === item.author &&
          candidate.recipient === item.recipient &&
          candidate.content.every((block) => block.type === "input_text"),
      );
      const plaintext = report?.content.map((block) => block.text).join("\n");
      if (
        !plaintext?.startsWith("Message Type: FINAL_ANSWER\n") ||
        hashText(plaintext) !== entry.report_sha256
      )
        throw incompatible();
      changed = true;
      return {
        type: "input_text",
        text: `Recovery notice: Copilot rejected this historical encrypted progress update. Its original ciphertext remains unchanged in the native session archive. The exact plaintext final report from ${item.author} is present in this request as message ${entry.report_id} (SHA-256 ${entry.report_sha256}). Read that report and its referenced artifacts for current findings. This notice does not decrypt or reconstruct the earlier progress message; do not infer its missing details.`,
      };
    });
    return content.some((part, index) => part !== item.content[index])
      ? { ...item, content }
      : item;
  });
  return changed ? { ...payload, input } : payload;
}
