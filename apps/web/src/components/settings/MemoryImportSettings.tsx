import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  AuthMemoryWriteScope,
  AuthFilesystemReadScope,
  MemoryOperationId,
  type EnvironmentId,
  type MemorySpaceId,
  type MemoryImportSourceFormat,
  type MemoryImportSource,
  type MemoryImportPreviewItem,
} from "@goat/contracts";
import {
  memoryImportFormatLabels,
  memoryImportFormats,
  memoryImportIssueReason,
} from "@goat/client-runtime/memory-import-workflow";
import { useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";
import { memoryImportRequestFailureMessage } from "@goat/client-runtime/memory-import-workflow";
import { useEnvironment } from "../../state/environments";
import { memoryEnvironment } from "../../state/memory";
import {
  registerMemoryImportDestination,
  createMemoryImportAdmission,
  canSafelyImport,
  unsafeImportBrowserMessage,
  changedImportDestinationMessage,
} from "../../lib/memoryImportRecoveryStorage";
import { randomUUID } from "../../lib/utils";
import { MemoryScopeSettings, type MemoryScopeSelection } from "./MemoryScopeSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

/** A mount may check a saved receipt; only the explicit Apply button admits writes. */
export function MemoryImportSettings({
  environmentId,
  memorySpaceId,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
}) {
  const registry = useContext(RegistryContext);
  const canImport = useAtomValue(memoryEnvironment.importProvider.permissionAtom(environmentId));
  const formats = memoryImportFormats(
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities,
  );
  const [admission] = useState(() => {
    try {
      return createMemoryImportAdmission({ environmentId, memorySpaceId });
    } catch {
      return null;
    }
  });
  const [workflow] = useState(() => {
    try {
      if (!admission) return null;
      return memoryEnvironment.createImportWorkflow(registry, {
        fence: { environmentId, memorySpaceId, session: randomUUID() },
        recovery: admission.recovery,
        operationId: () => MemoryOperationId.make(randomUUID()),
      });
    } catch {
      return null;
    }
  });
  const progress = useSyncExternalStore(
    workflow?.subscribe ?? (() => () => {}),
    workflow?.getSnapshot ?? (() => undefined),
  );
  const [format, setFormat] = useState<MemoryImportSourceFormat | null>(null);
  const [sources, setSources] = useState<readonly MemoryImportSource[]>([]);
  const [items, setItems] = useState<readonly MemoryImportPreviewItem[]>([]);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [scopeEpoch, setScopeEpoch] = useState(0);
  const [scope, setScope] = useState<MemoryScopeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(false);
  const authorized = useRef(canImport);
  const generation = useRef(0);
  const previousScope = useRef<MemoryScopeSelection | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    const token = generation.current;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (error) {
      if (mounted.current && token === generation.current)
        setError(
          memoryImportRequestFailureMessage(error) ??
            "Import request failed. Check the result before previewing again.",
        );
    }
    if (mounted.current && token === generation.current) {
      setBusy(false);
    }
  };
  useEffect(() => {
    mounted.current = true;
    if (canImport) authorized.current = true;
    // Recover synchronizes the saved handle with the server, never admitting a write.
    // eslint-disable-next-line react/set-state-in-effect
    if (canImport && workflow) void run(() => workflow.recover());
    if (
      !canImport &&
      authorized.current &&
      workflow &&
      readPreparedConnection(environmentId) !== null &&
      (!readEnvironmentScope(environmentId, AuthMemoryWriteScope) ||
        !readEnvironmentScope(environmentId, AuthFilesystemReadScope))
    ) {
      generation.current++;
      setItems([]);
      setSelected([]);
      setSources([]);
      setBusy(true);
      void workflow
        .removeDestination()
        .then(() => {
          if (mounted.current) {
            setBusy(false);
          }
        })
        .catch(() => {
          if (mounted.current) setError("Could not clear saved import recovery.");
        });
    }
    return () => {
      mounted.current = false;
      generation.current++;
      if (
        workflow &&
        authorized.current &&
        readPreparedConnection(environmentId) !== null &&
        (!readEnvironmentScope(environmentId, AuthMemoryWriteScope) ||
          !readEnvironmentScope(environmentId, AuthFilesystemReadScope))
      )
        void workflow.removeDestination().catch(() => undefined);
      else workflow?.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
    };
  }, [canImport, workflow, run, environmentId, memorySpaceId]);
  const changeScope = (next: MemoryScopeSelection | null) => {
    const previous = previousScope.current;
    previousScope.current = next;
    setScope(next);
    if (JSON.stringify(previous) === JSON.stringify(next) || !workflow) return;
    generation.current++;
    workflow.stop();
    workflow.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
    setItems([]);
    setSelected([]);
    setBusy(false);
  };
  const invalidateDestination = async () => {
    generation.current++;
    previousScope.current = null;
    setScope(null);
    setScopeEpoch((current) => current + 1);
    workflow?.stop();
    workflow?.invalidate({ environmentId, memorySpaceId, session: randomUUID() });
    setError(changedImportDestinationMessage);
    setBusy(false);
    setItems([]);
    setSelected([]);
    setSources([]);
  };
  useEffect(() => {
    const unsubscribe = admission?.subscribeInvalidation(() => {
      void invalidateDestination();
    });
    const unregister = registerMemoryImportDestination(
      { environmentId, memorySpaceId },
      invalidateDestination,
    );
    return () => {
      unsubscribe?.();
      unregister();
    };
  }, [environmentId, memorySpaceId, invalidateDestination, admission]);
  const locked =
    busy ||
    ["previewed", "save_failed", "recovery", "saving", "applying", "checking"].includes(
      progress?.phase ?? "",
    );
  return (
    <SettingsSection title="Import memories">
      <SettingsRow
        title="Provider memories"
        description={`Import supported ${new Intl.ListFormat("en", { type: "disjunction" }).format(formats.map((f) => memoryImportFormatLabels[f]))} memories from the selected device. Other providers are not supported. Memory write and file read permissions are required.${formats.includes("aside") ? " Aside imports only the Current section of each page; project pages need a project scope." : ""}`}
      >
        <div className="space-y-3">
          <Select
            value={format}
            disabled={!canImport || locked || !workflow}
            onValueChange={(value) => {
              setFormat(value);
              setSources([]);
              setItems([]);
              setSelected([]);
              workflow?.invalidate();
            }}
          >
            <SelectTrigger aria-label="Import provider">
              <SelectValue placeholder="Choose a provider" />
            </SelectTrigger>
            <SelectPopup>
              {formats.map((value) => (
                <SelectItem key={value} value={value}>
                  {memoryImportFormatLabels[value]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
          <MemoryScopeSettings
            key={scopeEpoch}
            environmentId={environmentId}
            memorySpaceId={memorySpaceId}
            disabled={!canImport || locked}
            onChange={changeScope}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!workflow || !canImport || !format || !scope || locked}
              onClick={() =>
                void run(async () => {
                  setItems([]);
                  setSelected([]);
                  const result = await workflow!.discover(format!);
                  if (result && mounted.current) setSources(result.sources);
                })
              }
            >
              Discover profiles
            </Button>
            {sources.map((source, index) => (
              <Button
                key={source.sourceId}
                size="sm"
                variant="outline"
                disabled={!canImport || locked}
                onClick={() =>
                  void run(async () => {
                    setItems([]);
                    setSelected([]);
                    await admission!.capturePreview();
                    const result = await workflow!.preview(source.sourceId);
                    if (result && mounted.current) setItems(result.items);
                  })
                }
              >
                {source.format === "aside"
                  ? `Preview ${source.label}`
                  : `Preview profile ${index + 1}`}
              </Button>
            ))}
          </div>
          {progress?.phase === "discovered" && sources.length === 0 ? (
            <p className="text-xs leading-normal text-muted-foreground/80">
              No supported profiles found on this device.
            </p>
          ) : null}
          {items.length > 0 ? (
            <div role="group" aria-label="Choose memories to import">
              {items.map((item, index) => (
                <label key={item.sourceItemKey} className="block space-x-2">
                  <input
                    type="checkbox"
                    disabled={
                      !canImport || locked || item.issue !== undefined || !item.sourceFingerprint
                    }
                    checked={selected.includes(item.sourceItemKey)}
                    onChange={(event) => {
                      const checked = event.currentTarget.checked;
                      setSelected((current) =>
                        checked
                          ? [...current, item.sourceItemKey]
                          : current.filter((key) => key !== item.sourceItemKey),
                      );
                    }}
                  />
                  <span>
                    {item.title ??
                      (format === "aside" ? item.sourceItemKey : `Memory ${index + 1}`)}
                    {item.issue !== undefined
                      ? ` · ${memoryImportIssueReason(item.issue, "item")}`
                      : ""}
                    {item.tooLargeForTurnStart
                      ? " · Stored, but too large to add to new turns automatically"
                      : ""}
                  </span>
                </label>
              ))}
            </div>
          ) : progress?.phase === "selecting" ? (
            <p className="text-xs leading-normal text-muted-foreground/80">
              No importable memories found in this profile.
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!canImport || locked || !scope || selected.length === 0}
              onClick={() => {
                if (!workflow || !scope) return;
                try {
                  workflow.select(
                    items
                      .filter(
                        (item) => selected.includes(item.sourceItemKey) && item.sourceFingerprint,
                      )
                      .map((item) => ({
                        sourceItemKey: item.sourceItemKey,
                        sourceFingerprint: item.sourceFingerprint!,
                        ...scope,
                      })),
                  );
                } catch {
                  setError("Preview again before confirming your selection.");
                }
              }}
            >
              Confirm selection
            </Button>
          </div>
          {progress?.phase === "previewed" ? (
            <div className="space-y-3" role="group" aria-label="Confirm import">
              <p className="text-xs leading-normal text-muted-foreground/80">
                Import {selected.length} selected memories into the chosen scope on this device?
                Chunks of up to 32 run in sequence.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={!canImport || busy || !canSafelyImport()}
                  onClick={() => void run(() => workflow!.apply())}
                >
                  Apply import
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy}
                  onClick={() => {
                    workflow?.invalidate();

                    setItems([]);
                    setSelected([]);
                  }}
                >
                  Cancel selection
                </Button>
              </div>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={!busy && progress?.phase !== "save_failed"}
              onClick={() => {
                workflow?.stop();
              }}
            >
              Stop import
            </Button>
            {progress?.phase === "save_failed" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canImport || busy || !canSafelyImport()}
                onClick={() => void run(() => workflow!.retry())}
              >
                Retry saving import
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={!workflow || !canImport || busy}
              onClick={() => void run(() => workflow!.recover())}
            >
              Check import result
            </Button>
          </div>
        </div>
      </SettingsRow>
      {!canSafelyImport() ? (
        <SettingsRow
          title="Import unavailable"
          description={<span role="alert">{unsafeImportBrowserMessage}</span>}
        />
      ) : null}
      {!workflow ? (
        <SettingsRow
          title="Browser storage unavailable"
          description={
            <span role="alert">
              Browser storage is unavailable. Imports require saved recovery information.
            </span>
          }
        />
      ) : null}
      {progress &&
      (busy ||
        progress.message ||
        progress.stopped ||
        ["saving", "applying", "checking", "recovery", "partial", "completed"].includes(
          progress.phase,
        )) ? (
        <SettingsRow
          title="Import progress"
          description={
            <span role="status">
              {busy ? "Import request in progress. " : ""}
              {progress.message}
              {progress.stopped ? " Future chunks stopped. Already sent work can finish." : ""}{" "}
              {progress.phase === "applying" || progress.receipt
                ? `${progress.settledChunks} chunks completed.`
                : null}
            </span>
          }
        />
      ) : null}
      {progress?.receipt ? (
        <SettingsRow
          title="Import result"
          description={
            <>
              {progress.receipt.state === "partial"
                ? "Partial import; some memories may have been applied."
                : "Import results received across all chunks."}{" "}
              {progress.totals.outcomes.created ?? 0} created,{" "}
              {progress.totals.outcomes.revised ?? 0} updated,{" "}
              {progress.totals.outcomes.rejected ?? 0} rejected. Acceptance does not mean content is
              available on every device.
            </>
          }
        />
      ) : null}
      {error ? (
        <SettingsRow
          title="Import needs attention"
          description={<span role="alert">{error}</span>}
        />
      ) : null}
    </SettingsSection>
  );
}
