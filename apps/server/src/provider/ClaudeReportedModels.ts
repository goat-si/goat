import type { ModelInfo as ClaudeModelInfo } from "@anthropic-ai/claude-agent-sdk";
import type { CustomModelSetting, ServerProviderModel } from "@goat/contracts";
import { readCustomModelEntries } from "@goat/shared/model";
import {
  CLAUDE_CODE_FAMILY_ALIASES,
  type ClaudeModelCatalog,
  stripClaudeBackendDecoration,
} from "./ClaudeModelCatalog.ts";

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
): { models: ReadonlyArray<ServerProviderModel>; hasNonCatalogModels: boolean } {
  if (!reported?.length) return { models: [], hasNonCatalogModels: false };
  const catalogIds = new Set(
    catalog.models
      .flatMap(({ model }) => [model.slug, ...(model.aliases ?? [])])
      .map((id) => stripClaudeContextWindowSuffix(id).toLowerCase()),
  );
  const customIds = new Set(
    readCustomModelEntries(customModels).map((entry) =>
      stripClaudeContextWindowSuffix(entry.slug).toLowerCase(),
    ),
  );
  const known = new Set([...catalogIds, ...customIds]);
  let hasNonCatalogModels = false;
  const models: Array<ServerProviderModel> = [];
  for (const info of reported) {
    const slug = info.value.trim();
    // `default` is Claude Code's pointer at its own default model, not a model.
    if (!slug || slug === "default") continue;
    const valueId = stripClaudeContextWindowSuffix(slug).toLowerCase();
    const resolvedId = stripClaudeContextWindowSuffix(info.resolvedModel ?? "").toLowerCase();
    const ids = [valueId, resolvedId].filter((id) => id.length > 0);
    const gatewayValue = !catalogIds.has(valueId);
    // Claude Code can report family routes from environment settings even on a gateway cache miss.
    const reportsGatewayModel = gatewayValue
      ? customIds.has(valueId) || !catalogIds.has(resolvedId)
      : resolvedId !== "" &&
        (customIds.has(valueId) || customIds.has(resolvedId)) &&
        !catalogIds.has(resolvedId) &&
        !catalogIds.has(stripClaudeBackendDecoration(resolvedId));
    if (reportsGatewayModel && !CLAUDE_CODE_FAMILY_ALIASES.has(valueId)) {
      hasNonCatalogModels = true;
    }
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
  return { models, hasNonCatalogModels };
}
