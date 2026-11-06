import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { CustomModelSetting, ServerProviderModel } from "@goat/contracts";
import { readCustomModelEntries } from "@goat/shared/model";
import type { ClaudeModelCatalog } from "./ClaudeModelCatalog.ts";

const CLAUDE_EFFORT_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

function stripClaudeContextWindowSuffix(value: string): string {
  return value.replace(/\[[^\]]*\]$/, "").trim();
}

export function claudeReportedModels(
  catalog: ClaudeModelCatalog,
  customModels: ReadonlyArray<CustomModelSetting>,
  reported: ReadonlyArray<ClaudeModelInfo> | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!reported?.length) return [];
  const known = new Set(
    [
      ...catalog.models.flatMap(({ model }) => [model.slug, ...(model.aliases ?? [])]),
      ...readCustomModelEntries(customModels).map((entry) => entry.slug),
    ].map((id) => stripClaudeContextWindowSuffix(id).toLowerCase()),
  );
  const models: Array<ServerProviderModel> = [];
  for (const info of reported) {
    const slug = info.value.trim();
    // `default` is Claude Code's pointer at its own default model, not a model.
    if (!slug || slug === "default") continue;
    const ids = [slug, info.resolvedModel ?? ""]
      .map((id) => stripClaudeContextWindowSuffix(id).toLowerCase())
      .filter((id) => id.length > 0);
    if (ids.some((id) => known.has(id))) continue;
    for (const id of ids) known.add(id);
    const efforts = info.supportsEffort ? (info.supportedEffortLevels ?? []) : [];
    models.push({
      slug,
      name: info.displayName.trim() || slug,
      isCustom: false,
      capabilities: {
        optionDescriptors: efforts.length
          ? [
              {
                id: "effort",
                label: "Reasoning",
                type: "select",
                // `default` is not an effort, so choosing it sends none and Claude Code picks.
                options: [
                  { id: "default", label: "Default", isDefault: true },
                  ...efforts.map((id) => ({ id, label: CLAUDE_EFFORT_LABELS[id] ?? id })),
                ],
              },
            ]
          : [],
      },
    });
  }
  return models;
}
