import { useAtomValue } from "@effect/atom-react";
import {
  BOAT_MACHINE_STATUS_LABEL,
  type BoatMachineIdentity,
} from "@goat/client-runtime/cloud-machines";
import type { FleetSnapshot } from "@goat/client-runtime/state/fleet";
import type { FleetHeatTier, FleetMachineHeat } from "@goat/client-runtime/state/fleet-heat";
import {
  presentConnectionWait,
  presentHostStorage,
} from "@goat/client-runtime/state/fleet-host-health";
import { cpuPercent, memoryPercent } from "@goat/client-runtime/state/host-metrics";
import type { EnvironmentId, ServerEventLoopStall } from "@goat/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { memo, useEffect, useRef } from "react";

import { ChevronDownIcon } from "~/components/solar";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { useNowWhile } from "~/hooks/useNowWhile";
import { cn } from "~/lib/utils";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { fleetEnvironmentsAtom, fleetPageEnvironmentsAtom } from "~/state/fleet";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { environmentServerConfigsAtom } from "~/state/server";
import { environmentThreadShells } from "~/state/threads";
import { useUiStateStore } from "~/uiStateStore";

import { platformLabel } from "../settings/hostStatusView";
import { BoatIcon } from "../Icons";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { fleetHostCount } from "./fleetCount";
import { FleetAlertAction } from "./FleetAlertAction";
import { isFleetConnectionWait, type FleetConnection } from "./fleetConnection";
import { fleetConsoleFrameClassName } from "./fleetConsoleFrame";
import { fleetConsoleTelemetryAtom } from "./fleetConsoleTelemetry";
import { FleetUncountedHosts } from "./FleetUncountedHosts";
import {
  fleetAlerts,
  fleetThroughput,
  fleetHostRows,
  hottestHost,
  hottestReading,
  signalTier,
  quotaRows,
  sparklinePath,
  throughputEqual,
  THROUGHPUT_BUCKETS,
  type FleetAlert,
  type FleetAlertTone,
  type FleetHostRow,
  type FleetThroughput,
  lastKnownLabel,
  type HostLastSeen,
  type HostSample,
} from "./fleetTelemetry";

/**
 * Runs in the last hour. Shell updates stream constantly, so the atom keeps its previous value
 * until a count changes and the console renders only then. Each host-status answer moves the
 * window forward, so a quiet fleet's counts still age out without a timer of their own.
 */
const fleetThroughputAtom = Atom.make((get): FleetThroughput => {
  const connected = new Set(get(fleetEnvironmentsAtom).map((env) => env.environmentId));
  get(fleetConsoleTelemetryAtom);
  const next = fleetThroughput(
    get(environmentThreadShells.threadShellsAtom),
    connected,
    Date.now(),
  );
  const previous = Option.getOrNull(get.self<FleetThroughput>());
  return previous !== null && throughputEqual(previous, next) ? previous : next;
}).pipe(Atom.withLabel("fleet-throughput"));

const Label = ({ children, className }: { children: React.ReactNode; className?: string }) => (
  <span
    className={cn("font-mono text-3xs uppercase tracking-widest text-muted-foreground", className)}
  >
    {children}
  </span>
);

/** A reading colored on the graph's heat thresholds and palette; muted when the host sent none. */
const tone = (key: Parameters<typeof signalTier>[0], value: number | null) =>
  value === null ? "muted" : signalTier(key, value);

const TONE_TEXT = {
  normal: "text-foreground",
  warm: "text-heat-warm",
  hot: "text-heat-hot",
  burning: "text-heat-burning",
  muted: "text-muted-foreground",
} as const;

const TONE_BAR = {
  normal: "bg-primary",
  warm: "bg-heat-warm",
  hot: "bg-heat-hot",
  burning: "bg-heat-burning",
  muted: "bg-muted-foreground",
} as const;

const HEAT_DOT = {
  warm: "bg-heat-warm",
  hot: "bg-heat-hot",
  burning: "bg-heat-burning",
} as const;

const ALERT_DOT: Record<FleetAlertTone, string> = {
  destructive: "bg-destructive",
  warning: "bg-warning",
  muted: "border border-muted-foreground",
};

/** One series as one path. Re-renders only when a host gets a new sample. */
const Sparkline = memo(function Sparkline(props: {
  readonly samples: ReadonlyArray<HostSample>;
  readonly field: "cpu" | "memory" | "load";
  readonly max: number;
  readonly tone: keyof typeof TONE_TEXT;
}) {
  const path = sparklinePath(
    props.samples.map((sample) => sample[props.field]),
    100,
    16,
    props.max,
  );
  return (
    <svg
      aria-hidden
      viewBox="0 0 100 16"
      preserveAspectRatio="none"
      className={cn(
        "h-4 min-w-0 flex-1 overflow-visible",
        props.tone === "normal" ? "text-primary" : TONE_TEXT[props.tone],
      )}
    >
      <line x1="0" x2="100" y1="15.5" y2="15.5" className="fleet-console-baseline" />
      <path d={path} className="fleet-console-spark" vectorEffect="non-scaling-stroke" />
    </svg>
  );
});

const NO_SAMPLES: ReadonlyArray<HostSample> = [];

function formatPercent(value: number | null) {
  return value === null ? "–" : Math.round(value) + "%";
}

/**
 * Why a machine has no host status yet: its connection is not up, or an answer is on its way.
 * A connection attempt says how long it has run and which step it is on.
 */
function noMetricsText(
  connection: FleetConnection | undefined,
  reading: boolean,
  now: number,
): string {
  if (
    connection !== undefined &&
    isFleetConnectionWait(connection.state) &&
    connection.since !== undefined
  ) {
    return presentConnectionWait({
      step: connection.step ?? null,
      sinceMs: connection.since,
      nowMs: now,
    }).text;
  }
  switch (connection?.state) {
    case "connecting":
    case "reconnecting":
    case "unreachable":
    case "offline":
    case "stopped":
      return connection.label;
    default:
      return reading ? "Reading…" : "No metrics";
  }
}

/**
 * "macmini · macOS · 10 cores", with how old the numbers are when the host stopped answering,
 * and its storage against both budgets.
 */
function hostDetail(row: FleetHostRow, lastSeen: HostLastSeen, now: number): string {
  const metrics = row.entry?.metrics;
  const parts = [row.label, platformLabel(metrics?.platform)];
  if (metrics !== undefined)
    parts.push(metrics.cpuCount + (metrics.cpuCount === 1 ? " core" : " cores"));
  parts.push(lastKnownLabel(row, lastSeen, now));
  if (metrics?.storage !== undefined) {
    const storage = presentHostStorage(metrics.storage, now);
    parts.push(storage.summary, storage.archive);
  }
  if (row.tone === "none") parts.push("no host status describes this machine");
  return parts.filter((part) => part !== null).join(" · ");
}

function HostRow({
  row,
  boat,
  samples,
  lastSeen,
  observedAt,
  heatTier,
  connection,
  reading,
  now,
  answeringLate,
}: {
  readonly row: FleetHostRow;
  readonly boat: BoatMachineIdentity | null;
  readonly samples: ReadonlyArray<HostSample>;
  readonly lastSeen: HostLastSeen;
  readonly observedAt: number;
  /** The machine's tier as its node in the graph shows it. */
  readonly heatTier: FleetHeatTier;
  readonly connection: FleetConnection | undefined;
  /** A host-status read is still on its way, so a row without an answer may yet get one. */
  readonly reading: boolean;
  readonly now: number;
  /** The host is connected but not answering, or froze recently: its alert's tone. */
  readonly answeringLate: FleetAlertTone | null;
}) {
  const metrics = row.entry?.metrics;
  const stale = row.tone === "stale";
  const statusText =
    row.tone === "none"
      ? noMetricsText(connection, reading, now)
      : row.tone === "unsupported"
        ? "Update GOAT to report"
        : metrics === undefined
          ? boat !== null && boat.status !== "running" && boat.status !== "unknown"
            ? BOAT_MACHINE_STATUS_LABEL[boat.status]
            : "Unreachable"
          : null;
  // The graph's rounded helpers, so a reading on a threshold gets the same color as the ring.
  const cpu = metrics === undefined ? null : cpuPercent(metrics);
  const memory = metrics === undefined ? null : memoryPercent(metrics);
  const load = metrics?.loadAvg?.oneMinute ?? null;
  const cores = metrics?.cpuCount ?? 1;
  const loadMax = Math.max(cores, ...samples.map((sample) => sample.load ?? 0));
  const loadTone = tone("load", load === null ? null : load / cores);
  return (
    <li className="grid h-7 grid-cols-[minmax(0,6.5rem)_repeat(3,minmax(0,1fr))] items-center gap-3">
      <span className="flex min-w-0 items-center gap-1.5 text-xs">
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            row.tone === "ok" && answeringLate !== null
              ? answeringLate === "destructive"
                ? "bg-destructive"
                : "bg-warning"
              : row.tone === "ok"
                ? heatTier === "normal"
                  ? "bg-success"
                  : HEAT_DOT[heatTier]
                : row.tone === "stale" || row.tone === "unreachable"
                  ? "bg-warning"
                  : "border border-muted-foreground",
          )}
        />
        {boat !== null ? (
          <BoatIcon role="img" aria-label="Boat" className="size-3 shrink-0" />
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={<span className="truncate font-medium outline-hidden" tabIndex={0} />}
          >
            {row.label}
          </TooltipTrigger>
          <TooltipPopup side="top">{hostDetail(row, lastSeen, observedAt)}</TooltipPopup>
        </Tooltip>
      </span>
      {statusText !== null ? (
        <span className="col-span-3 truncate font-mono text-2xs text-muted-foreground">
          {statusText}
        </span>
      ) : (
        <>
          <MetricCell
            value={formatPercent(cpu)}
            tone={tone("cpu", cpu)}
            stale={stale}
            samples={samples}
            field="cpu"
            max={100}
          />
          <MetricCell
            value={formatPercent(memory)}
            tone={tone("memory", memory)}
            stale={stale}
            samples={samples}
            field="memory"
            max={100}
          />
          <MetricCell
            value={load === null ? "–" : load.toFixed(load >= 10 ? 0 : 1)}
            tone={loadTone}
            stale={stale}
            samples={samples}
            field="load"
            max={loadMax}
          />
        </>
      )}
    </li>
  );
}

function MetricCell(props: {
  readonly value: string;
  readonly tone: keyof typeof TONE_TEXT;
  readonly stale: boolean;
  readonly samples: ReadonlyArray<HostSample>;
  readonly field: "cpu" | "memory" | "load";
  readonly max: number;
}) {
  return (
    <span className={cn("flex min-w-0 items-center gap-2", props.stale && "opacity-55")}>
      <Sparkline samples={props.samples} field={props.field} max={props.max} tone={props.tone} />
      <span
        className={cn(
          "w-9 shrink-0 text-right font-mono text-xs tabular-nums",
          TONE_TEXT[props.tone === "muted" ? "muted" : props.tone],
        )}
      >
        {props.value}
      </span>
    </span>
  );
}

/** Started runs rise above the line, finished ones hang below: one path each. */
const ThroughputBars = memo(function ThroughputBars({
  throughput,
}: {
  readonly throughput: FleetThroughput;
}) {
  const width = 120;
  const half = 14;
  const slot = width / THROUGHPUT_BUCKETS;
  const peak = Math.max(1, ...throughput.startedBuckets, ...throughput.finishedBuckets);
  const bars = (counts: ReadonlyArray<number>, direction: 1 | -1) =>
    counts
      .map((count, index) => {
        if (count === 0) return "";
        const height = Math.max(1.5, (count / peak) * (half - 1));
        const x = (index * slot + 1).toFixed(2);
        const y = direction === 1 ? half - height : half + 1;
        return (
          "M" +
          x +
          " " +
          y.toFixed(2) +
          "h" +
          (slot - 2).toFixed(2) +
          "v" +
          height.toFixed(2) +
          "h-" +
          (slot - 2).toFixed(2) +
          "Z"
        );
      })
      .join("");
  return (
    <svg
      aria-hidden
      viewBox={"0 0 " + width + " " + (half * 2 + 1)}
      preserveAspectRatio="none"
      className="h-7 w-full"
    >
      <line x1="0" x2={width} y1={half + 0.5} y2={half + 0.5} className="fleet-console-baseline" />
      <path d={bars(throughput.startedBuckets, 1)} className="fill-info" />
      <path d={bars(throughput.finishedBuckets, -1)} className="fill-success" />
    </svg>
  );
});

function Stat(props: { readonly label: string; readonly value: number; readonly dot: string }) {
  return (
    <div className="flex items-center gap-2">
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", props.dot)} />
      <Label>{props.label}</Label>
      <span aria-hidden className="fleet-console-leader" />
      <span className="font-mono text-lg leading-none tabular-nums">{props.value}</span>
    </div>
  );
}

const clock = new Intl.DateTimeFormat(undefined, {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function FleetConsoleExpanded(props: {
  readonly snapshot: FleetSnapshot;
  readonly connections: ReadonlyMap<string, FleetConnection>;
  readonly heat: ReadonlyMap<string, FleetMachineHeat>;
  readonly reduced: boolean;
  readonly onCollapse: () => void;
}) {
  const { snapshot, connections, heat, reduced } = props;
  const status = useAtomValue(fleetConsoleTelemetryAtom);
  const environments = useAtomValue(fleetPageEnvironmentsAtom);
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const throughput = useAtomValue(fleetThroughputAtom);
  const configs = useAtomValue(environmentServerConfigsAtom);
  const rows = fleetHostRows({
    machines: snapshot.machines,
    sshAliases: new Map(environments.map((env) => [env.environmentId, env.sshAliases] as const)),
    reports: status.reports,
    primaryEnvironmentId,
  });
  const unreadable = status.failed.map((environmentId) => ({
    key: environmentId,
    label: environments.find((env) => env.environmentId === environmentId)?.label ?? environmentId,
  }));
  const environmentOf = new Map<string, EnvironmentId>(
    snapshot.machines.flatMap((machine) =>
      machine.environmentId === null ? [] : [[machine.id, machine.environmentId] as const],
    ),
  );
  const stalls = new Map<EnvironmentId, ServerEventLoopStall>();
  for (const [environmentId, config] of configs) {
    if (config.lastEventLoopStall !== undefined)
      stalls.set(environmentId, config.lastEventLoopStall);
  }
  // Ticks only while something is in progress, so waits show elapsed time and turn slow on time.
  const inProgress =
    status.pendingSince.size > 0 ||
    [...connections.values()].some((connection) => isFleetConnectionWait(connection.state)) ||
    rows.some((row) => row.entry?.metrics?.storage?.compactingSince !== undefined);
  const now = Math.max(useNowWhile(inProgress), status.observedAt);
  const alerts = fleetAlerts(rows, connections, now, {
    unreadable,
    lastSeen: status.lastSeen,
    environmentOf,
    pendingSince: status.pendingSince,
    stalls,
  });
  // A host that is not answering takes its alert's color on the row, so both say the same.
  const answeringLate = new Map(
    alerts.flatMap((alert) =>
      alert.key.endsWith(":responsive")
        ? [[alert.key.slice(0, -":responsive".length), alert.tone] as const]
        : [],
    ),
  );
  const hottest = hottestHost(rows, heat);
  const quotas = quotaRows(rows).slice(0, 3);
  const { totals } = snapshot;
  const hostCount = fleetHostCount({ rows, machines: snapshot.machines, connections });
  const boatByMachine = new Map(
    snapshot.machines.flatMap((machine) =>
      machine.boat === null ? [] : [[machine.id, machine.boat] as const],
    ),
  );

  return (
    <>
      <ConsoleHeader collapsed={false} onToggle={props.onCollapse}>
        {hottest === null ? null : (
          <span className="hidden min-w-0 items-baseline gap-1.5 sm:flex">
            <Label>Hottest</Label>
            <span className="truncate text-xs font-medium">{hottest.row.label}</span>
            <span className={cn("font-mono text-xs tabular-nums", TONE_TEXT[hottest.tier])}>
              {hottestReading(hottest)}
            </span>
          </span>
        )}
        {status.sampledAt > 0 ? (
          <span className="hidden items-baseline gap-1.5 md:flex">
            <Label>Sampled</Label>
            <span className="font-mono text-xs text-muted-foreground tabular-nums">
              {clock.format(status.sampledAt)}
            </span>
          </span>
        ) : null}
      </ConsoleHeader>
      <div className="grid h-[calc(100%-2.5rem)] auto-rows-max grid-cols-1 overflow-y-auto md:auto-rows-[minmax(0,1fr)] md:grid-cols-[12.5rem_minmax(0,1fr)_16rem] md:overflow-hidden">
        {reduced || status.sampledAt === 0 ? null : (
          // Restarts once per new sample; nothing runs between samples.
          <span key={status.sampledAt} aria-hidden className="fleet-console-sweep" />
        )}

        <section
          aria-label="Threads"
          className="flex flex-col gap-3 border-b p-3 md:border-r md:border-b-0"
        >
          <div className="flex flex-col gap-2">
            <Stat label="Running" value={totals.running} dot="bg-info" />
            <Stat label="Need you" value={totals.attention} dot="bg-warning" />
            <Stat label="Reported" value={totals.reported} dot="border border-muted-foreground" />
          </div>
          <div className="mt-auto flex flex-col gap-1">
            <div className="flex items-baseline justify-between gap-2 whitespace-nowrap">
              <Label>1h</Label>
              <span className="font-mono text-2xs text-muted-foreground tabular-nums">
                <span className="text-info">{throughput.started}</span> started ·{" "}
                <span className="text-success">{throughput.finished}</span> done
              </span>
            </div>
            <ThroughputBars throughput={throughput} />
          </div>
        </section>

        <section
          aria-label="Hosts"
          className="flex min-h-0 flex-col border-b p-3 md:border-r md:border-b-0"
        >
          <div className="mb-1 grid grid-cols-[minmax(0,6.5rem)_repeat(3,minmax(0,1fr))] items-center gap-3">
            <span className="flex min-w-0 items-center gap-1">
              <Label>
                Hosts {hostCount.reporting}/{totals.machines}
              </Label>
              <FleetUncountedHosts hosts={hostCount.uncounted} />
            </span>
            <Label>CPU</Label>
            <Label>Mem</Label>
            <Label>Load 1m</Label>
          </div>
          {rows.length === 0 && status.loading ? (
            <p className="font-mono text-2xs text-muted-foreground">Reading hosts…</p>
          ) : (
            <ul className="flex min-h-0 flex-col md:overflow-y-auto">
              {rows.map((row) => (
                <HostRow
                  key={row.key}
                  row={row}
                  boat={row.machineId === null ? null : (boatByMachine.get(row.machineId) ?? null)}
                  lastSeen={status.lastSeen}
                  heatTier={
                    row.machineId === null ? "normal" : (heat.get(row.machineId)?.tier ?? "normal")
                  }
                  connection={row.machineId === null ? undefined : connections.get(row.machineId)}
                  reading={status.loading}
                  observedAt={status.observedAt}
                  now={now}
                  answeringLate={answeringLate.get(row.key) ?? null}
                  samples={
                    (row.sourceKey === null ? undefined : status.history.get(row.sourceKey)) ??
                    NO_SAMPLES
                  }
                />
              ))}
            </ul>
          )}
        </section>

        <section aria-label="Status" className="flex min-h-0 flex-col gap-3 p-3 md:overflow-y-auto">
          {quotas.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <Label>Quota</Label>
              {quotas.map((quota) => (
                <div key={quota.key} className="flex flex-col gap-0.5">
                  <span className="flex items-baseline gap-2 text-xs">
                    <span className="truncate">
                      {quota.label}
                      {quota.host === null ? null : (
                        <span className="text-muted-foreground"> · {quota.host}</span>
                      )}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
                      {quota.windows
                        .map((window) => window.label + " " + Math.round(window.usedPercent) + "%")
                        .join(" · ")}
                    </span>
                  </span>
                  <span
                    className="h-1 overflow-hidden rounded-full bg-muted"
                    role="meter"
                    aria-label={quota.label + " quota used"}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={Math.round(quota.peak)}
                  >
                    <span
                      className={cn(
                        "block h-full rounded-full",
                        TONE_BAR[tone("quota", quota.peak)],
                      )}
                      style={{ width: Math.max(2, quota.peak) + "%" }}
                    />
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          <div className="flex flex-col gap-1">
            <Label>Alerts {alerts.length > 0 ? alerts.length : null}</Label>
            {alerts.length === 0 ? (
              <span className="font-mono text-2xs text-muted-foreground">All clear</span>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {alerts.slice(0, 3).map((alert) => (
                  <AlertRow key={alert.key} alert={alert} />
                ))}
                {alerts.length > 3 ? (
                  <li>
                    <Popover>
                      <PopoverTrigger
                        render={
                          <button
                            type="button"
                            className="rounded-sm font-mono text-2xs text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                          />
                        }
                      >
                        +{alerts.length - 3} more
                      </PopoverTrigger>
                      <PopoverPopup side="top" align="start" width="md">
                        <ul aria-label="More alerts" className="flex flex-col gap-1">
                          {alerts.slice(3).map((alert) => (
                            <AlertRow key={alert.key} alert={alert} />
                          ))}
                        </ul>
                      </PopoverPopup>
                    </Popover>
                  </li>
                ) : null}
              </ul>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

/** One alert: what is wrong, where, and its one next step. Long details clamp to two lines. */
function AlertRow({ alert }: { readonly alert: FleetAlert }) {
  return (
    <li data-fleet-alert className="flex min-w-0 items-start gap-1.5 text-xs leading-4">
      <span
        aria-hidden
        className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", ALERT_DOT[alert.tone])}
      />
      {/*
       * The host and what is wrong read as one sentence, so the detail wraps under the host
       * name and leaves room for the action. Long ones clamp to two lines, then the tooltip.
       */}
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className="line-clamp-2 min-w-0 flex-1 text-muted-foreground wrap-anywhere outline-hidden"
              tabIndex={0}
            />
          }
        >
          <span className="font-medium text-foreground">{alert.label}</span>{" "}
          <span>{alert.detail}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">
          <span className="flex max-w-sm flex-col gap-0.5">
            <span>{alert.detail}</span>
            {alert.lines?.map((line) => (
              <span key={line} className="font-mono text-2xs opacity-80">
                {line}
              </span>
            ))}
          </span>
        </TooltipPopup>
      </Tooltip>
      {alert.action === undefined ? null : (
        <span className="-my-0.5 flex min-w-0 shrink-0 items-center gap-1.5">
          <FleetAlertAction
            kind={alert.action.kind}
            environmentId={alert.action.environmentId}
            label={alert.label}
          />
        </span>
      )}
    </li>
  );
}

function ConsoleHeader(props: {
  readonly collapsed: boolean;
  readonly onToggle: () => void;
  readonly children?: React.ReactNode;
}) {
  return (
    <header className={cn("flex h-10 items-center gap-4 px-3", !props.collapsed && "border-b")}>
      <span className="flex shrink-0 items-center gap-2">
        <span aria-hidden className="fleet-console-mark" />
        <h2 className="font-mono text-2xs uppercase tracking-widest text-muted-foreground">
          Fleet telemetry
        </h2>
      </span>
      {props.children}
      <Button
        size="icon-xs"
        variant="ghost-muted"
        className="ml-auto shrink-0"
        aria-expanded={!props.collapsed}
        aria-label={props.collapsed ? "Expand fleet telemetry" : "Collapse fleet telemetry"}
        onClick={props.onToggle}
      >
        <ChevronDownIcon className={cn("size-3.5", !props.collapsed && "rotate-180")} />
      </Button>
    </header>
  );
}

/**
 * Live fleet analytics above the graph, from the same reads and heat the graph uses.
 * Collapsing unmounts the body and its sweep; the frame keeps the same height as the
 * placeholder that preceded it.
 */
export default function FleetConsole(props: {
  readonly snapshot: FleetSnapshot;
  readonly connections: ReadonlyMap<string, FleetConnection>;
  readonly heat: ReadonlyMap<string, FleetMachineHeat>;
}) {
  const collapsed = useUiStateStore((state) => state.fleetConsoleCollapsed);
  const setCollapsed = useUiStateStore((state) => state.setFleetConsoleCollapsed);
  const reduced = useMediaQuery("(prefers-reduced-motion: reduce)");
  const frameRef = useRef<HTMLElement>(null);
  useEffect(() => observeVisibleAnimation(frameRef.current), []);
  const { totals } = props.snapshot;

  return (
    <section
      ref={frameRef}
      aria-label="Fleet telemetry"
      data-collapsed={collapsed || undefined}
      className={fleetConsoleFrameClassName(collapsed)}
    >
      <span aria-hidden className="fleet-console-corners" />
      {collapsed ? (
        <ConsoleHeader collapsed onToggle={() => setCollapsed(false)}>
          <span className="truncate font-mono text-xs text-muted-foreground tabular-nums">
            <span className="text-foreground">{totals.running}</span> running ·{" "}
            <span className="text-foreground">{totals.attention}</span> need you ·{" "}
            <span className="text-foreground">{totals.reported}</span> reported
          </span>
        </ConsoleHeader>
      ) : (
        <FleetConsoleExpanded
          snapshot={props.snapshot}
          connections={props.connections}
          heat={props.heat}
          reduced={reduced}
          onCollapse={() => setCollapsed(true)}
        />
      )}
    </section>
  );
}
