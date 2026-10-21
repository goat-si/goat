import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type EnvironmentMachineKind,
} from "@goat/contracts";
import { limitsNotice } from "@goat/shared/usageLimits";
import { useContext } from "react";

import { useLiveRefresh } from "~/hooks/useLiveRefresh";
import { cn } from "~/lib/utils";
import { HOST_STATUS_REFRESH_MS, hostStatusAtom, refreshHostStatus } from "~/state/hostStatus";
import { useEnvironmentScope } from "~/state/session";
import { Badge } from "../ui/badge";
import { LimitWindows } from "../usage/UsageLimits";
import { EnvironmentRow } from "./EnvironmentRow";
import { FoldedSettingsSection } from "./FoldedSettingsSection";
import { type HostCardView, type HostMeterView, hostCards, NOT_AVAILABLE } from "./hostStatusView";
import { providerClients } from "./providerDriverMeta";
import { ProviderHostMatrixSection } from "./ProviderHostMatrixSection";
import { searchableSetting } from "./settingsSearch";

const TONE_BADGE = {
  ok: "success",
  stale: "warning",
  unavailable: "error",
} as const satisfies Record<HostCardView["tone"], "success" | "warning" | "error">;

function MeterBar({ meter }: { readonly meter: HostMeterView }) {
  const used = meter.usedPercent;
  return (
    <>
      <span className="text-muted-foreground">{meter.label}</span>
      <div
        role="meter"
        aria-label={`${meter.label} in use`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used ?? undefined}
        aria-valuetext={meter.detail}
        className="h-1.5 overflow-hidden rounded-full bg-muted"
      >
        {used === null ? null : (
          <div
            className={cn(
              "h-full rounded-full",
              used >= 90 ? "bg-destructive" : used >= 75 ? "bg-warning" : "bg-foreground/50",
            )}
            style={{ width: `${used}%` }}
          />
        )}
      </div>
      <span className="truncate text-end text-muted-foreground tabular-nums">{meter.detail}</span>
    </>
  );
}

function HostCard({
  card,
  kind,
  now,
}: {
  readonly card: HostCardView;
  readonly kind: EnvironmentMachineKind;
  readonly now: number;
}) {
  return (
    <EnvironmentRow
      kind={kind}
      label={card.label}
      subtitle={[card.platform ?? "Platform not reported", card.version]
        .filter((part) => part !== null)
        .join(" · ")}
      detail={
        <div className="flex flex-col gap-3 text-xs empty:hidden">
          {card.message ? (
            <p className="break-words text-muted-foreground">{card.message}</p>
          ) : null}
          {card.meters === null ? null : (
            <div className="grid grid-cols-[5.5rem_minmax(3rem,1fr)_minmax(0,auto)] items-center gap-x-3 gap-y-1.5">
              {card.meters.map((meter) => (
                <MeterBar key={meter.label} meter={meter} />
              ))}
              <span className="text-muted-foreground">Load</span>
              <span className="col-span-2 text-foreground tabular-nums">
                {card.loadAverage ?? NOT_AVAILABLE}
              </span>
              {card.threads ? (
                <>
                  <span className="text-muted-foreground">Threads</span>
                  <span className="col-span-2 text-foreground tabular-nums">
                    {card.threads.running} running · {card.threads.waiting} waiting for input ·{" "}
                    {card.threads.queued} queued
                  </span>
                </>
              ) : null}
              {card.computerUse ? (
                <>
                  <span className="text-muted-foreground">Computer use</span>
                  <span className="col-span-2 break-words text-foreground">{card.computerUse}</span>
                </>
              ) : null}
            </div>
          )}
          {card.quotas.map((quota) => {
            const notice = limitsNotice(quota.limits);
            return (
              <div key={quota.instanceId} className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-muted-foreground">
                  {quota.displayName ??
                    providerClients.get(quota.driver)?.label ??
                    String(quota.driver)}
                </span>
                {notice ? (
                  <span className="text-muted-foreground">{notice}</span>
                ) : (
                  <LimitWindows
                    compact
                    driver={quota.driver}
                    windows={quota.limits.windows}
                    now={now}
                  />
                )}
              </div>
            );
          })}
        </div>
      }
    >
      <Badge variant={TONE_BADGE[card.tone]}>{card.status}</Badge>
    </EnvironmentRow>
  );
}

/** Mounted only while the section is open, so a closed section reads nothing. */
function HostsPanel({
  environmentId,
  localLabel,
  localKind,
}: {
  readonly environmentId: EnvironmentId;
  readonly localLabel: string;
  readonly localKind: EnvironmentMachineKind;
}) {
  const registry = useContext(RegistryContext);
  const atom = hostStatusAtom(environmentId);
  const result = useAtomValue(atom);
  const reachesHosts = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  useLiveRefresh(() => refreshHostStatus(registry, atom), {
    key: `host-status:${environmentId}`,
    intervalMs: HOST_STATUS_REFRESH_MS,
  });

  if (result._tag === "Initial") {
    return <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">Reading hosts…</p>;
  }
  if (result._tag === "Failure") {
    return (
      <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
        Could not read host status.
      </p>
    );
  }
  const now = result.timestamp;
  return (
    <>
      {hostCards(result.value.hosts, now, localLabel).map((card) => (
        <HostCard key={card.key} card={card} kind={card.local ? localKind : "server"} now={now} />
      ))}
      {reachesHosts ? null : (
        <p className="px-3 py-2.5 text-xs text-muted-foreground sm:px-4">
          Connected SSH hosts are listed for sessions that can operate threads.
        </p>
      )}
    </>
  );
}

/**
 * This machine and every SSH host it is connected to: reachability, CPU,
 * memory, disk, load, thread counts, and provider quota, from the same read
 * agents get through goat_host_status.
 */
export function HostsSettings({
  environmentId,
  localLabel,
  localKind,
}: {
  readonly environmentId: EnvironmentId;
  readonly localLabel: string;
  readonly localKind: EnvironmentMachineKind;
}) {
  const { id, title } = searchableSetting("hosts");
  return (
    <>
      <FoldedSettingsSection id={id} title={title} summary="This machine and connected SSH hosts">
        <HostsPanel environmentId={environmentId} localLabel={localLabel} localKind={localKind} />
      </FoldedSettingsSection>
      <ProviderHostMatrixSection environmentId={environmentId} />
    </>
  );
}
