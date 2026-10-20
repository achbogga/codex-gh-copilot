// Compare wire model identities without treating a different model as a pass.
// Copilot uses dotted Claude IDs; Anthropic also uses hyphenated versions.
// Haiku 4.5's published alias resolves to this fixed dated snapshot.
const canonical = (value) => {
  if (typeof value !== "string" || !value) return undefined;
  if (!value.startsWith("claude-")) return value;
  const id = value.replaceAll(".", "-");
  return id === "claude-haiku-4-5-20251001" ? "claude-haiku-4-5" : id;
};

export function sameInferenceModel(requested, served) {
  const expected = canonical(requested);
  return expected !== undefined && expected === canonical(served);
}
