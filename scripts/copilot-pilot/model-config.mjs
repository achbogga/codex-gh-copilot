import { readFile, writeFile } from "node:fs/promises";
import { usesMessages } from "./anthropic-request.mjs";

export function reasoningForModel(model, requested = "max") {
  const supported = model.capabilities?.supports?.reasoning_effort ?? [];
  if (!supported.length) return undefined;
  if (supported.includes(requested)) return requested;
  if (requested === "max")
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
        tool_mode: "code_mode_only",
        truncation_policy: { mode: "tokens", limit: 10000 },
        experimental_supported_tools: [],
        model_messages: { instructions_template: prompt },
      }),
      slug: model.id,
      display_name: model.name ?? model.id,
      description: `${model.name ?? model.id} through GitHub Copilot`,
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
      auto_compact_token_limit: Math.floor(
        Math.min(
          limits.max_prompt_tokens,
          limits.max_context_window_tokens - (limits.max_output_tokens ?? 0),
        ) * 0.95,
      ),
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
  const compact = Math.floor(
    Math.min(
      limits.max_prompt_tokens,
      limits.max_context_window_tokens - (limits.max_output_tokens ?? 0),
    ) * 0.95,
  );
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
      tool_mode: "code_mode_only",
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
