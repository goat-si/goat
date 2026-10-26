import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import type { EnvironmentId, StorageCleanResult, StorageItem } from "@goat/contracts";
import { useContext, useState } from "react";

import { formatBytes } from "../../lib/formatBytes";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  cleanupBatches,
  diskSummary,
  initialSelection,
  largestWorktrees,
  mergeCleanResults,
  selectionSummary,
  STORAGE_KIND_LABELS,
  STORAGE_STATE_LABELS,
  storageTotals,
} from "./DiskUsageSettings.logic";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";

const failureText = (failure: unknown) =>
  failure instanceof Error && failure.message.length > 0 ? failure.message : String(failure);

/**
 * Free disk space and what GOAT's own folders hold on each selected machine, with the cleanup a
 * person confirms item by item. Machines whose server predates it show nothing here.
 */
export function DiskUsageSection() {
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.storageUsage === true,
  );
  if (supported.length === 0) return null;
  return (
    <SettingsSection id="storage-disk-usage" title="Disk usage">
      {supported.map((environment) => (
        <EnvironmentDiskUsage
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={
            supported.length > 1
              ? settingsScopeEnvironmentLabel(environment, connectedEnvironments)
              : null
          }
        />
      ))}
    </SettingsSection>
  );
}

const LEVEL_BADGE = { ok: null, elevated: "warning", critical: "error" } as const;

function EnvironmentDiskUsage(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const target = { environmentId: props.environmentId, input: {} };
  const usage = useAtomValue(serverEnvironment.storageUsage(target));
  const pressure = useAtomValue(serverEnvironment.diskPressure(target));
  const allowed = useAtomValue(
    serverEnvironment.cleanUpStorageItems.permissionAtom(props.environmentId),
  );
  const scan = useAtomCommand(serverEnvironment.scanStorage, { reportFailure: false });
  const registry = useContext(RegistryContext);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const report = usage._tag === "Success" ? usage.value : null;
  const live = pressure._tag === "Success" ? pressure.value : null;
  const disk = diskSummary(report?.disk ?? null, live);
  const refresh = () => registry.refresh(serverEnvironment.storageUsage(target));
  const rescan = async () => {
    setScanning(true);
    setScanError(null);
    const result = await scan({ environmentId: props.environmentId, input: { rescan: true } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result))
      setScanError(failureText(squashAtomCommandFailure(result)));
    setScanning(false);
    refresh();
  };
  const prefix = props.label === null ? "" : props.label + ": ";
  const totals = report === null ? [] : storageTotals(report.items);
  const removable = report?.items.filter((item) => item.state === "removable") ?? [];
  const badge = disk.level === null ? null : LEVEL_BADGE[disk.level];
  return (
    <>
      <SettingsRow
        title={prefix + "Free space"}
        description={
          <span className="flex flex-wrap items-center gap-1.5">
            {disk.text}
            {badge !== null && (
              <Badge variant={badge} size="sm">
                {disk.level === "critical" ? "Almost full" : "Running low"}
              </Badge>
            )}
          </span>
        }
        control={
          <Button variant="outline" size="xs" disabled={scanning} onClick={() => void rescan()}>
            {scanning ? "Scanning…" : "Scan again"}
          </Button>
        }
      />
      <SettingsRow
        title={prefix + "GOAT folders"}
        description={
          scanError !== null
            ? "Could not scan: " + scanError
            : usage._tag === "Failure"
              ? "Could not load the last scan."
              : report === null
                ? "Scanning GOAT's folders…"
                : "Scanned " +
                  formatRelativeTimeLabel(report.scannedAt) +
                  ". " +
                  formatBytes(removable.reduce((sum, item) => sum + (item.bytes ?? 0), 0)) +
                  " can be removed."
        }
        control={
          <Button
            variant="outline"
            size="xs"
            disabled={report === null || removable.length === 0 || !allowed}
            onClick={() => setCleaning(true)}
          >
            Clean up…
          </Button>
        }
      >
        {report !== null && (
          <div className="mt-2 flex flex-col gap-2 text-xs">
            <ul className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-0.5">
              {totals.map((total) => (
                <li key={total.kind} className="contents">
                  <span className="text-muted-foreground">
                    {total.label} ({total.count})
                  </span>
                  <span className="tabular-nums">{formatBytes(total.bytes)}</span>
                </li>
              ))}
            </ul>
            {largestWorktrees(report.items, 5).length > 0 && (
              <ul className="flex flex-col gap-0.5">
                {largestWorktrees(report.items, 5).map((item) => (
                  <li key={item.id} className="flex min-w-0 items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">{item.label}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {STORAGE_STATE_LABELS[item.state]}
                    </span>
                    <span className="w-16 shrink-0 text-right tabular-nums">
                      {item.bytes === null ? "–" : formatBytes(item.bytes)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {report.notes.map((note) => (
              <p key={note} className="text-muted-foreground">
                {note}
              </p>
            ))}
          </div>
        )}
      </SettingsRow>
      {cleaning && report !== null && (
        <StorageCleanupDialog
          environmentId={props.environmentId}
          items={report.items}
          onClose={() => {
            setCleaning(false);
            refresh();
          }}
        />
      )}
    </>
  );
}

/** Lists every path the cleanup would delete, with its size, and deletes only what is ticked. */
function StorageCleanupDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly items: ReadonlyArray<StorageItem>;
  readonly onClose: () => void;
}) {
  const [selected, setSelected] = useState(() => initialSelection(props.items));
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<StorageCleanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const clean = useAtomCommand(serverEnvironment.cleanUpStorageItems, { reportFailure: false });
  const summary = selectionSummary(props.items, selected);
  const toggle = (id: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  const run = async () => {
    setPending(true);
    setError(null);
    // The server takes a limited number of items per request; larger selections go in turn, and
    // what finished before a failure is still shown.
    const finished: Array<StorageCleanResult> = [];
    for (const items of cleanupBatches(summary.items)) {
      const outcome = await clean({ environmentId: props.environmentId, input: { items } });
      if (outcome._tag === "Success") {
        finished.push(outcome.value);
        continue;
      }
      // A request that failed may still have removed the item the server was working on.
      if (!isAtomCommandInterrupted(outcome))
        setError(
          "The cleanup stopped: " +
            failureText(squashAtomCommandFailure(outcome)) +
            ". Items in that request may already be gone, and later ones were not tried. Closing scans again.",
        );
      break;
    }
    setResult(mergeCleanResults(finished));
    setPending(false);
  };
  const kinds = [...new Set(props.items.map((item) => item.kind))];
  return (
    <Dialog open onOpenChange={(open) => !open && !pending && props.onClose()}>
      <DialogPopup className="max-h-[85dvh] sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Clean up GOAT storage</DialogTitle>
          <DialogDescription>
            Deleting cannot be undone. Worktrees qualify only with no uncommitted changes, every
            commit on a remote and no thread using them, and each item is checked again right before
            it goes. GOAT servers share no lock, so a write another GOAT server makes to a checkout
            during its removal is not protected.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {result !== null ? (
            <ul className="flex flex-col gap-1 text-xs">
              <li className="font-medium">
                Freed {formatBytes(result.freedBytes)}. Every deletion is logged in {result.logPath}
                .
              </li>
              {result.results.map((entry) => (
                <li key={entry.id} className="flex gap-2">
                  <span className={entry.outcome === "removed" ? "" : "text-muted-foreground"}>
                    {entry.outcome === "removed"
                      ? "Removed"
                      : entry.outcome === "skipped"
                        ? "Kept"
                        : "Failed"}
                  </span>
                  <span className="min-w-0 flex-1 break-all">{entry.path}</span>
                  {entry.outcome !== "removed" && (
                    <span className="text-muted-foreground">{entry.reason}</span>
                  )}
                </li>
              ))}
              {error !== null && (
                <li role="alert" className="text-destructive-foreground">
                  {error}
                </li>
              )}
            </ul>
          ) : (
            <div className="flex flex-col gap-4 text-xs">
              {kinds.map((kind) => (
                <section key={kind} className="flex flex-col gap-1">
                  <h3 className="font-medium text-sm">{STORAGE_KIND_LABELS[kind]}</h3>
                  {props.items
                    .filter((item) => item.kind === kind)
                    .map((item) => (
                      <label key={item.id} className="flex min-w-0 items-start gap-2">
                        <Checkbox
                          aria-label={"Delete " + item.path}
                          disabled={item.state !== "removable" || pending}
                          checked={item.state === "removable" && selected.has(item.id)}
                          onCheckedChange={(checked) => toggle(item.id, checked === true)}
                        />
                        <span className="flex min-w-0 flex-1 flex-col">
                          <span className="break-all">{item.path}</span>
                          <span className="text-muted-foreground">
                            {STORAGE_STATE_LABELS[item.state]} · {item.reason}
                            {item.detail === undefined ? "" : " · " + item.detail}
                          </span>
                        </span>
                        <span className="w-16 shrink-0 text-right tabular-nums">
                          {item.bytes === null ? "–" : formatBytes(item.bytes)}
                        </span>
                      </label>
                    ))}
                </section>
              ))}
              {error !== null && (
                <p role="alert" className="text-destructive-foreground">
                  {error}
                </p>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {result !== null ? (
            <Button onClick={props.onClose}>Done</Button>
          ) : (
            <>
              <Button variant="ghost" disabled={pending} onClick={props.onClose}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={pending || summary.count === 0}
                onClick={() => void run()}
              >
                {pending
                  ? "Deleting…"
                  : "Delete " +
                    summary.count +
                    (summary.count === 1 ? " item" : " items") +
                    " · " +
                    formatBytes(summary.bytes) +
                    (summary.unmeasured > 0 ? "+" : "")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
