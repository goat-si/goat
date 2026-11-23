import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  UsageLimitsReport,
  UsageLimitSourceAccount,
  UsageLimitSourceSnapshots,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { hasProviderUsageLimits, providersWithLimits } from "./usageLimitCommands.ts";
import {
  accountKeyResolver,
  nativeReport,
  hubAccountName,
  limitsNotice,
  routedThroughOpenCodex,
  localLimits,
} from "./usageAccounts.ts";
import { creditReportWins, newerCreditReport, shownCreditReport } from "./usageCreditSource.ts";
import { instanceHubs, hubRoutes } from "./usageModelRouting.ts";
export function collectProviderUsageLimits(
  instanceId: ProviderInstanceId,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
  model: string | null = null,
): UsageLimitsReport | null {
  const selected = providers.find((provider) => provider.instanceId === instanceId);
  if (!selected) return null;
  const hubs = instanceHubs(selected, sources);
  const routes =
    hubs.length > 0
      ? hubRoutes(hubs, selected.driver, model)
      : (account: UsageLimitSourceAccount) => account.driver === selected.driver;
  const shownHubs = hubs.length > 0 ? hubs : sources;
  const drivers = new Set(
    shownHubs.flatMap((source) => source.accounts.filter(routes).map((account) => account.driver)),
  );
  if (drivers.size === 0) drivers.add(selected.driver);
  if (![...drivers].some((driver) => hasProviderUsageLimits(driver, providers, sources)))
    return null;
  const resolveKey = accountKeyResolver([
    ...providers.filter((provider) => provider.enabled).map(nativeReport),
    ...sources.flatMap((source) => source.accounts),
  ]);
  const routedKeys =
    hubs.length > 0
      ? new Set(hubs.flatMap((source) => source.accounts.filter(routes).map(resolveKey)))
      : null;
  type NativeSnapshot = { provider: ServerProvider; limits: ServerProviderUsageLimits };
  const nativeByAccount = new Map<
    string,
    { usage: NativeSnapshot; credits: NativeSnapshot | null; balance: NativeSnapshot | null }
  >();
  for (const provider of providersWithLimits(providers)) {
    if (!drivers.has(provider.driver) || !provider.usageLimits) continue;
    const accountKey = resolveKey(nativeReport(provider));
    if (
      routedKeys &&
      (accountKey === null || !routedKeys.has(accountKey)) &&
      !(provider.instanceId === selected.instanceId && routedThroughOpenCodex(provider.usageLimits))
    )
      continue;
    const snapshot = { provider, limits: provider.usageLimits };
    const key = routedThroughOpenCodex(provider.usageLimits)
      ? `instance:${provider.instanceId}`
      : (accountKey ?? `instance:${provider.instanceId}`);
    const previous = nativeByAccount.get(key);
    const previousUsable = previous ? limitsNotice(previous.usage.limits) === null : false;
    const usable = limitsNotice(snapshot.limits) === null;
    const providerWins =
      !previous ||
      (usable && !previousUsable) ||
      (usable === previousUsable &&
        Date.parse(snapshot.limits.checkedAt) > Date.parse(previous.usage.limits.checkedAt));
    const previousCredit = previous?.credits;
    const credits =
      snapshot.limits.resetCredits &&
      creditReportWins(
        { limits: snapshot.limits, input: { instanceId: provider.instanceId } },
        previousCredit
          ? {
              limits: previousCredit.limits,
              input: { instanceId: previousCredit.provider.instanceId },
            }
          : null,
      )
        ? snapshot
        : (previousCredit ?? null);
    nativeByAccount.set(key, {
      usage: providerWins ? snapshot : previous.usage,
      credits,
      balance:
        snapshot.limits.resetCredits &&
        newerCreditReport(
          { limits: snapshot.limits, input: null },
          previous?.balance ? { limits: previous.balance.limits, input: null } : null,
        )
          ? snapshot
          : (previous?.balance ?? null),
    });
  }
  const native = [...nativeByAccount.values()];
  const nativeAccountKeys = new Set(
    native.flatMap(({ usage: { provider, limits } }) => {
      const key = resolveKey(nativeReport(provider));
      return key && limits.windows.length && !limits.unavailable ? [key] : [];
    }),
  );
  const accounts: Array<UsageLimitsReport["accounts"][number]> = [];
  const notices: string[] = [];
  for (const {
    usage: { provider, limits },
    credits,
    balance,
  } of native) {
    const routed = routedThroughOpenCodex(limits);
    const key = resolveKey(nativeReport(provider));
    const matchingHubCredits = shownHubs
      .flatMap((source) => source.accounts.map((account) => ({ source, account })))
      .filter(
        ({ account }) =>
          key !== null &&
          resolveKey(account) === key &&
          account.usageLimits.resetCredits &&
          !limitsNotice(account.usageLimits),
      );
    const hubBalance = [...matchingHubCredits].sort(
      (a, b) =>
        Date.parse(b.account.usageLimits.checkedAt) - Date.parse(a.account.usageLimits.checkedAt),
    )[0];
    const hubCredits = matchingHubCredits.sort((a, b) => {
      const report = (entry: typeof a) => ({
        limits: entry.account.usageLimits,
        input: entry.account.usageLimits.resetCredits?.nextCreditId
          ? {
              sourceId: entry.source.id,
              accountId: entry.account.id,
              creditId: entry.account.usageLimits.resetCredits.nextCreditId,
            }
          : null,
      });
      return creditReportWins(report(a), report(b))
        ? -1
        : creditReportWins(report(b), report(a))
          ? 1
          : 0;
    })[0];
    const hubCreditId = hubCredits?.account.usageLimits.resetCredits?.nextCreditId;
    const showHubCredits =
      hubCredits &&
      creditReportWins(
        {
          limits: hubCredits.account.usageLimits,
          input: hubCreditId
            ? {
                sourceId: hubCredits.source.id,
                accountId: hubCredits.account.id,
                creditId: hubCreditId,
              }
            : null,
        },
        credits
          ? { limits: credits.limits, input: { instanceId: credits.provider.instanceId } }
          : null,
      );
    const chosenReport =
      showHubCredits && hubCredits
        ? {
            limits: hubCredits.account.usageLimits,
            input: hubCreditId
              ? {
                  sourceId: hubCredits.source.id,
                  accountId: hubCredits.account.id,
                  creditId: hubCreditId,
                }
              : null,
          }
        : credits
          ? { limits: credits.limits, input: { instanceId: credits.provider.instanceId } }
          : null;
    const newestReport =
      hubBalance &&
      (!balance ||
        Date.parse(hubBalance.account.usageLimits.checkedAt) > Date.parse(balance.limits.checkedAt))
        ? { limits: hubBalance.account.usageLimits, input: null }
        : balance
          ? { limits: balance.limits, input: null }
          : null;
    const shownCredits = shownCreditReport(chosenReport, newestReport);
    accounts.push({
      id: provider.instanceId,
      driver: provider.driver,
      label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}]`,
      ...(routed
        ? {
            sourceLabel:
              limits.quotaPool === undefined
                ? "via OpenCodex"
                : `via OpenCodex Home ${limits.quotaPool.homeId}`,
          }
        : provider.auth.label
          ? { plan: provider.auth.label }
          : {}),
      instanceId: provider.instanceId,
      ...(routed
        ? {}
        : showHubCredits && !hubCreditId
          ? { redeemable: false }
          : {
              resetCreditInput:
                showHubCredits && hubCreditId && hubCredits
                  ? {
                      sourceId: hubCredits.source.id,
                      accountId: hubCredits.account.id,
                      creditId: hubCreditId,
                    }
                  : { instanceId: credits?.provider.instanceId ?? provider.instanceId },
            }),
      ...(provider.displayName ? { displayName: provider.displayName } : {}),
      ...(provider.accentColor ? { accentColor: provider.accentColor } : {}),
      ...(!routed && provider.auth.email ? { email: provider.auth.email } : {}),
      limits: !routed && shownCredits ? { ...limits, resetCredits: shownCredits } : limits,
    });
    const own = routed ? localLimits(limits) : undefined;
    if (own !== undefined) {
      // The routed login keeps its own quota and credits; the pool row above never has credits.
      accounts.push({
        id: `${provider.instanceId}:login`,
        driver: provider.driver,
        label: `${provider.displayName?.trim() || String(provider.driver)} [${provider.instanceId}] · own login`,
        instanceId: provider.instanceId,
        ...(own.redeemable
          ? { resetCreditInput: { instanceId: provider.instanceId } }
          : { redeemable: false }),
        ...(provider.auth.label ? { plan: provider.auth.label } : {}),
        ...(provider.auth.email ? { email: provider.auth.email } : {}),
        limits: own.limits,
      });
    }
  }
  for (const source of shownHubs) {
    const matching = source.accounts.filter(routes);
    for (const account of matching) {
      const key = resolveKey(account);
      if (key && nativeAccountKeys.has(key)) continue;
      accounts.push({
        id: `${source.id}:${account.id}`,
        driver: account.driver,
        label: `${source.label} · ${account.label ?? hubAccountName(account)}`,
        sourceLabel: source.kind === "opencodex" ? source.label : "CLI Proxy",
        ...(account.usageLimits.resetCredits?.nextCreditId
          ? {
              resetCreditInput: {
                sourceId: source.id,
                accountId: account.id,
                creditId: account.usageLimits.resetCredits.nextCreditId,
              },
            }
          : {}),
        ...(account.plan ? { plan: account.plan } : {}),
        ...(account.email ? { email: account.email } : {}),
        limits: account.usageLimits,
      });
    }
    if (source.error && (matching.length > 0 || source.accounts.length === 0)) {
      notices.push(`${source.label}: ${source.error}`);
    }
  }
  return { createdAt: DateTime.formatIso(DateTime.makeUnsafe(now)), accounts, notices };
}
