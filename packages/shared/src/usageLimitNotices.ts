import { providersWithLimits } from "./usageLimitCommands.ts";
import {
  limitAccountKeys,
  limitsNotice,
  localLimits,
  routedThroughOpenCodex,
  type LimitPresentations,
} from "./usageLimits.ts";

export function collectLimitNotices(presentations: LimitPresentations): readonly string[] {
  const label = (environmentLabel: string, subject: string) =>
    presentations.size > 1 ? `${environmentLabel} · ${subject}` : subject;
  const resolveKey = limitAccountKeys(presentations);
  const shown = new Set<string>();
  for (const [environmentId, presentation] of presentations) {
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const limits = provider.usageLimits;
      if (!limits) continue;
      const own = routedThroughOpenCodex(limits) ? localLimits(limits)?.limits : limits;
      if (own && limitsNotice(own) === null) {
        const report = {
          driver: provider.driver,
          email: provider.auth.email,
          workspaceId: provider.auth.workspaceId,
          usageLimits: own,
        };
        shown.add(resolveKey(report) ?? `${environmentId}:${provider.instanceId}`);
      }
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      for (const account of source.accounts) {
        if (limitsNotice(account.usageLimits) === null) {
          shown.add(
            resolveKey(account) ??
              `${environmentId}:${source.id}:${account.id}:${account.workspaceId ?? ""}`,
          );
        }
      }
    }
  }
  const notices = new Set<string>();
  for (const [environmentId, presentation] of presentations) {
    const environmentLabel = presentation.entry.target.label;
    for (const provider of providersWithLimits(presentation.serverConfig?.providers ?? [])) {
      const limits = provider.usageLimits;
      if (
        limits?.unavailable?.reason === "unsupported" &&
        (!limits.unavailable.message || limits.externalUsage)
      )
        continue;
      const notice = limits ? limitsNotice(limits) : null;
      const name = provider.displayName?.trim() || String(provider.driver);
      if (notice) notices.add(`${label(environmentLabel, name)}: ${notice}`);
    }
    for (const source of presentation.serverConfig?.usageLimitSources ?? []) {
      if (source.error) notices.add(`${label(environmentLabel, source.label)}: ${source.error}`);
      else if (source.accounts.length === 0)
        notices.add(`${label(environmentLabel, source.label)}: No accounts reported.`);
      for (const account of source.accounts) {
        if (account.usageLimits.unavailable?.reason !== "probeFailed") continue;
        const key =
          resolveKey(account) ??
          `${environmentId}:${source.id}:${account.id}:${account.workspaceId ?? ""}`;
        if (shown.has(key)) continue;
        const name = account.email ?? account.label ?? account.id.replace(/\.json$/i, "");
        notices.add(
          `${label(environmentLabel, source.label)} · ${name}: ${limitsNotice(account.usageLimits)}`,
        );
      }
    }
  }
  return [...notices];
}
