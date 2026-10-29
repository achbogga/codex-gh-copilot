import { readFile, writeFile } from "node:fs/promises";
import { usesMessages } from "./anthropic-request.mjs";

// Native retries retain partial output. Keep this bound and the compaction
// reserve together so a reconnect cannot silently consume all summary space.
export const STREAM_MAX_RETRIES = 1;

export function modelInputLimit(model) {
  const limits = model.capabilities?.limits ?? {};
  return Math.min(
    limits.max_prompt_tokens ?? Infinity,
    (limits.max_context_window_tokens ?? Infinity) -
      (limits.max_output_tokens ?? 0),
  );
}

export function modelCompactLimit(model) {
  const input = modelInputLimit(model);
  const output = model.capabilities?.limits?.max_output_tokens ?? 0;
  // Reserve the failed attempt and its retry before another native turn can
  // compact. Small-window models retain at least half their input budget; this
  // is headroom, not a guarantee that arbitrary tool output will fit.
  return Math.floor(
    Math.max(input * 0.5, input * 0.95 - output * (STREAM_MAX_RETRIES + 1)),
  );
}

export function reasoningForModel(model, requested = "max") {
  const supported = model.capabilities?.supports?.reasoning_effort ?? [];
  if (!supported.length) return undefined;
  if (supported.includes(requested)) return requested;
  // Native model switching/compaction can carry the other model's effort.
  // Normalize known levels to the destination's strongest supported level.
  if (
    ["max", "xhigh", "high", "medium", "low", "minimal", "none"].includes(
      requested,
    )
  )
    return ["max", "xhigh", "high", "medium", "low", "minimal", "none"].find(
      (effort) => supported.includes(effort),
    );
  throw new Error(`Unsupported reasoning effort ${requested} for ${model.id}.`);
}

export async function catalogArguments(
  models,
  selected,
  reasoning,
  catalogPath,
) {
  const bundled = JSON.parse(
    await readFile(
      new URL("../../codex-rs/models-manager/models.json", import.meta.url),
      "utf8",
    ),
  );
  const prompt = await readFile(
    new URL("../../codex-rs/models-manager/prompt.md", import.meta.url),
    "utf8",
  );
  const entries = models.map((model, priority) => {
    const limits = model.capabilities.limits;
    const efforts = model.capabilities.supports.reasoning_effort ?? [];
    const known = bundled.models.find((entry) => entry.slug === model.id);
    return {
      ...(known ?? {
        shell_type: "unified_exec",
        support_verbosity: false,
        supports_reasoning_summary_parameter: false,
        apply_patch_tool_type: "freeform",
        // Expose native direct tools alongside Code Mode. Providers trained on
        // shell/patch tools can then continue either native tool history format.
        tool_mode: "code_mode",
        truncation_policy: { mode: "tokens", limit: 10000 },
        experimental_supported_tools: [],
        model_messages: { instructions_template: prompt },
      }),
      slug: model.id,
      display_name: model.name ?? model.id,
      description: `${model.name ?? model.id} through GitHub Copilot`,
      // Our adapters preserve a common visible session format. Keep full history
      // on normal switches; native Codex uses the source model when a smaller
      // destination needs compaction. This also migrates old GPT hash "3000".
      comp_hash: "copilot-pilot/portable-session-v3",
      default_reasoning_level: reasoningForModel(model) ?? null,
      supported_reasoning_levels: efforts.map((effort) => ({
        effort,
        description: effort,
      })),
      visibility: "list",
      supported_in_api: true,
      priority: model.id === selected.id ? 0 : priority + 1,
      upgrade: null,
      availability_nux: null,
      available_access_programs: null,
      service_tiers: [],
      additional_speed_tiers: [],
      default_service_tier: null,
      context_window: limits.max_context_window_tokens,
      max_context_window: limits.max_context_window_tokens,
      auto_compact_token_limit: modelCompactLimit(model),
      effective_context_window_percent: 95,
      input_modalities: model.capabilities.supports.vision
        ? ["text", "image"]
        : ["text"],
    };
  });
  await writeFile(catalogPath, JSON.stringify({ models: entries }), {
    mode: 0o600,
  });
  return [
    "-c",
    `model_catalog_json=${JSON.stringify(catalogPath)}`,
    "-c",
    `model_reasoning_effort=${JSON.stringify(reasoningForModel(selected, reasoning) ?? "none")}`,
    "-c",
    'model_auto_compact_token_limit_scope="total"',
  ];
}

export async function modelArguments(
  model,
  reasoning,
  catalogPath,
  visibleCatalogPath = catalogPath,
) {
  const limits = model.capabilities.limits;
  const compact = modelCompactLimit(model);
  const args = [
    "-c",
    `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    "-c",
    `model_context_window=${limits.max_context_window_tokens}`,
    "-c",
    `model_auto_compact_token_limit=${compact}`,
    "-c",
    'model_auto_compact_token_limit_scope="total"',
  ];
  let metadata;
  if (usesMessages(model)) {
    // Explicit metadata avoids Codex's unknown-model context cap and enables its
    // native patch tool and Code Mode without pretending Claude is a GPT model.
    metadata = {
      slug: model.id,
      display_name: model.name ?? model.id,
      description: "Claude through GitHub Copilot",
      default_reasoning_level: reasoning,
      supported_reasoning_levels:
        model.capabilities.supports.reasoning_effort.map((effort) => ({
          effort,
          description: effort,
        })),
      shell_type: "unified_exec",
      visibility: "list",
      supported_in_api: true,
      priority: 1,
      support_verbosity: false,
      supports_reasoning_summary_parameter: false,
      apply_patch_tool_type: "freeform",
      tool_mode: "code_mode",
      truncation_policy: { mode: "tokens", limit: 10000 },
      context_window: limits.max_context_window_tokens,
      max_context_window: limits.max_context_window_tokens,
      auto_compact_token_limit: compact,
      effective_context_window_percent: 95,
      experimental_supported_tools: [],
      input_modalities: ["text", "image"],
      base_instructions: await readFile(
        new URL("../../codex-rs/models-manager/prompt.md", import.meta.url),
        "utf8",
      ),
    };
  } else if (model.id.startsWith("gpt-")) {
    const bundled = JSON.parse(
      await readFile(
        new URL("../../codex-rs/models-manager/models.json", import.meta.url),
        "utf8",
      ),
    );
    metadata = bundled.models.find((entry) => entry.slug === model.id);
  }
  if (metadata) {
    await writeFile(
      catalogPath,
      JSON.stringify({
        models: [
          {
            ...metadata,
            context_window: limits.max_context_window_tokens,
            max_context_window: limits.max_context_window_tokens,
            auto_compact_token_limit: compact,
          },
        ],
      }),
      { mode: 0o600 },
    );
    args.push("-c", `model_catalog_json=${JSON.stringify(visibleCatalogPath)}`);
  }
  return args;
}
