// goat-rename: legacy: retained recordings use these keys; this module is GOAT-only.
const LEGACY_CODE_CONTEXT_PREFIX = "t3_code_"; // goat-rename: legacy: recorded context keys.
const GOAT_CODE_CONTEXT_PREFIX = "goat_code_";

export function normalizeGoatContextAliases(
  params: Record<string, unknown>,
  stringify: (value: unknown) => string,
): void {
  if (typeof params.additionalContext !== "object" || params.additionalContext === null) return;
  const additionalContext = { ...(params.additionalContext as Record<string, unknown>) };
  // Pre-discipline recordings stay valid while all other context remains compared.
  delete additionalContext[`${LEGACY_CODE_CONTEXT_PREFIX}development`];
  delete additionalContext[`${GOAT_CODE_CONTEXT_PREFIX}development`];
  for (const [key, entry] of Object.entries(additionalContext)) {
    if (!key.startsWith(LEGACY_CODE_CONTEXT_PREFIX)) continue;
    const goatKey = `${GOAT_CODE_CONTEXT_PREFIX}${key.slice(LEGACY_CODE_CONTEXT_PREFIX.length)}`;
    // Conflicting aliases must remain distinct so replay still detects lost context.
    if (goatKey in additionalContext && stringify(additionalContext[goatKey]) !== stringify(entry))
      continue;
    additionalContext[goatKey] = entry;
    delete additionalContext[key];
  }
  if (Object.keys(additionalContext).length === 0) delete params.additionalContext;
  else params.additionalContext = additionalContext;
}
