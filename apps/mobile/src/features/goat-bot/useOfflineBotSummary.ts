import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@goat/contracts";
import * as Equal from "effect/Equal";
import { Atom } from "effect/reactivity";
import { useContext, useEffect, useState } from "react";

import { environmentCatalog } from "../../connection/catalog";
import { useAppActive } from "../../lib/appState";
import { useDeadlinePassed } from "../../lib/clock";
import { environmentPresentations } from "../../state/presentation";
import { getKeptSummaryPersistence, keptSummaryChangeAtom } from "./keptPerComputerStore";
import { KEPT_SUMMARY_TTL, type KeptSummary } from "./keptSummaryStore";
import { isComputerReadable } from "./useKeptPerComputer";

const connectedComputersAtom = Atom.make(
  (get) =>
    new Set(
      [...get(environmentPresentations.presentationsAtom)]
        .filter(([, presentation]) => presentation.connection.phase === "connected")
        .map(([id]) => id),
    ),
).pipe(Atom.withEquality(Equal.equals));

const NO_ACCOUNT = Atom.make<string | null>(null);
export interface OfflineBotSummary {
  readonly environmentId: EnvironmentId;
  readonly bots: KeptSummary<"bots"> | null;
  readonly asks: KeptSummary<"asks"> | null;
}

export function useOfflineBotSummary(
  environmentId: EnvironmentId | null,
  visible: boolean,
): OfflineBotSummary | null {
  const registry = useContext(RegistryContext);
  const persistence = getKeptSummaryPersistence(registry);
  const accountAtom = persistence?.accountAtom ?? NO_ACCOUNT;
  const account = useAtomValue(accountAtom);
  const connected = useAtomValue(connectedComputersAtom);
  const catalog = useAtomValue(environmentCatalog.catalogValueAtom);
  const revision = useAtomValue(keptSummaryChangeAtom);
  const active = useAppActive();
  const [held, setHeld] = useState<{
    readonly account: typeof account;
    readonly catalog: typeof catalog;
    readonly revision: number;
    readonly selected: EnvironmentId | null;
    readonly summary: OfflineBotSummary;
  } | null>(null);

  const allowed =
    visible &&
    held !== null &&
    !connected.has(held.summary.environmentId) &&
    held.selected === environmentId &&
    held.revision === revision &&
    held.catalog === catalog &&
    held.account === account;
  const bots = allowed ? held.summary.bots : null;
  const asks = allowed ? held.summary.asks : null;
  const botsExpiry = bots === null ? null : bots.readAt + KEPT_SUMMARY_TTL;
  const asksExpiry = asks === null ? null : asks.readAt + KEPT_SUMMARY_TTL;
  const botsExpired = useDeadlinePassed(botsExpiry);
  const asksExpired = useDeadlinePassed(asksExpiry);
  const expiredAt = Math.max(
    botsExpired ? (botsExpiry ?? 0) : 0,
    asksExpired ? (asksExpiry ?? 0) : 0,
  );
  // oxlint-disable-next-line goat/react-effect-budget -- Restore a local summary for a readable offline pairing.
  useEffect(() => {
    if (!visible || !active || !catalog.isReady || persistence === undefined) return;
    let current = true;
    const ids = (environmentId === null ? [...catalog.entries.keys()] : [environmentId]).filter(
      (id) => !connected.has(id),
    );
    const readable = (id: EnvironmentId) =>
      isComputerReadable(registry, id) &&
      registry.get(environmentPresentations.presentationsAtom).get(id)?.connection.phase !==
        "connected";
    const restore = async () => {
      let latest: OfflineBotSummary | null = null;
      let latestAt = 0;
      for (const id of ids) {
        if (!readable(id)) continue;
        const lease = persistence.store.lease(id);
        const scopes = await persistence.scopes(registry, id, false);
        if (!current) return;
        const now = Math.max(Date.now(), expiredAt);
        let [bots, asks] = await Promise.all([
          persistence.store.restore(lease, "bots", scopes, now),
          persistence.store.restore(lease, "asks", scopes, now),
        ]);
        if (!current) return;
        if (bots !== null && asks !== null && bots.scope !== asks.scope) {
          if (bots.readAt >= asks.readAt)
            asks = await persistence.store.restore(lease, "asks", [bots.scope], now);
          else bots = await persistence.store.restore(lease, "bots", [asks.scope], now);
        }
        if (!current) return;
        if (!persistence.store.isCurrent(lease) || !readable(id)) continue;
        const readAt = Math.max(bots?.readAt ?? 0, asks?.readAt ?? 0);
        if (readAt > latestAt) {
          latestAt = readAt;
          latest = { environmentId: id, bots, asks };
        }
      }
      if (
        current &&
        registry.get(keptSummaryChangeAtom) === revision &&
        registry.get(accountAtom) === account &&
        registry.get(environmentCatalog.catalogValueAtom) === catalog
      )
        setHeld(
          latest === null
            ? null
            : { account, catalog, revision, selected: environmentId, summary: latest },
        );
    };
    void restore().catch(() => console.warn("Could not read the offline bot summary."));
    return () => {
      current = false;
    };
  }, [
    registry,
    persistence,
    catalog,
    connected,
    environmentId,
    visible,
    active,
    accountAtom,
    account,
    revision,
    expiredAt,
  ]);
  if (!allowed) return null;
  if ((bots === null || botsExpired) && (asks === null || asksExpired)) return null;
  return {
    environmentId: held.summary.environmentId,
    bots: botsExpired ? null : bots,
    asks: asksExpired ? null : asks,
  };
}
