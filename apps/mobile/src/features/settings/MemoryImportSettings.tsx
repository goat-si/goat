import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { useFocusEffect } from "@react-navigation/native";
import {
  MemoryOperationId,
  sessionGrantsScope,
  type MemoryImportSourceFormat,
  type MemoryImportProviderResult,
  type MemoryScope,
  type MemorySpaceId,
} from "@goat/contracts";
import {
  memoryImportFormatLabels,
  memoryImportFormats,
  memoryImportIssueReason,
} from "@goat/client-runtime/memory-import-workflow";
import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import * as Crypto from "expo-crypto";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { memoryImportRequestFailureMessage } from "@goat/client-runtime/memory-import-workflow";
import { mobileMemoryImportRecovery } from "../../persistence/memory-import-recovery";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { memoryEnvironment as memory } from "../../state/memory";
import { environmentSession } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { AppText as Text } from "../../components/ui/AppText";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsActionRow } from "./components/SettingsActionRow";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { nativeMemoryImportOutcomes } from "./SettingsMemoryRouteScreen.logic";
import type { MemoryScreenParams } from "./SettingsMemoryRouteScreen.logic";
import type { EnvironmentId } from "@goat/contracts";

type Discovery = Extract<MemoryImportProviderResult, { action: "discover" }>;
type Preview = Extract<MemoryImportProviderResult, { action: "preview" }>;
const Copy = ({ children }: { children: React.ReactNode }) => (
  <Text className="p-3 text-sm text-foreground-muted">{children}</Text>
);
const Action = (props: { label: string; disabled?: boolean; onPress: () => void }) => (
  <SettingsActionRow icon="brain" {...props} />
);

/** Mount/reconnect/foreground only recover status. Applying always requires two deliberate actions. */
export function MemoryImportSettings({
  params,
  memorySpaceId,
  scope,
  bindingToken,
  enabled,
  retireRef,
}: {
  params: MemoryScreenParams & { environmentId: EnvironmentId };
  memorySpaceId: MemorySpaceId;
  scope: MemoryScope | undefined;
  bindingToken: string;
  enabled: boolean;
  retireRef: React.RefObject<() => Promise<void>>;
}) {
  const registry = useContext(RegistryContext);
  const { savedConnectionsById } = useSavedRemoteConnections();
  const allowed = useAtomValue(memory.importProvider.permissionAtom(params.environmentId));
  const formats = memoryImportFormats(
    useAtomValue(serverEnvironment.configValueAtom(params.environmentId))?.environment.capabilities,
  );
  const connection = useAtomValue(
    environmentSession.preparedConnectionValueAtom(params.environmentId),
  );
  const grants = useAtomValue(environmentSession.sessionStateAtom(params.environmentId));
  const revoked =
    AsyncResult.isSuccess(grants) &&
    (!sessionGrantsScope(grants.value, "memory:write") ||
      !sessionGrantsScope(grants.value, "filesystem:read"));
  const [workflow] = useState(() =>
    memory.createImportWorkflow(registry, {
      fence: { environmentId: params.environmentId, memorySpaceId, session: Crypto.randomUUID() },
      recovery: mobileMemoryImportRecovery,
      operationId: () => MemoryOperationId.make(Crypto.randomUUID()),
    }),
  );
  const state = useSyncExternalStore(workflow.subscribe, workflow.getSnapshot);
  const [format, setFormat] = useState<MemoryImportSourceFormat | null>(null);
  const [sources, setSources] = useState<Discovery | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [destinationConfirmed, setDestinationConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const mounted = useRef(true);
  const generation = useRef(0);
  const previous = useRef({ connection, allowed, enabled, bindingToken, scope });
  const transition = useRef(Promise.resolve());
  const invalidateSelection = useCallback(() => {
    setPreview(null);
    setSources(null);
    setSelected(new Set());
    setDestinationConfirmed(false);
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      workflow.invalidate();
      // A lost connection preserves recovery. Explicit grant revocation removes this destination.
      const latestGrants = registry.get(environmentSession.sessionStateAtom(params.environmentId));
      if (
        AsyncResult.isSuccess(latestGrants) &&
        registry.get(environmentSession.preparedConnectionValueAtom(params.environmentId)) ===
          connection &&
        Option.isSome(connection) &&
        (!sessionGrantsScope(latestGrants.value, "memory:write") ||
          !sessionGrantsScope(latestGrants.value, "filesystem:read"))
      ) {
        void workflow.removeDestination().catch(() => {});
      }
    };
  }, [workflow, params.environmentId, registry, connection]);
  const run = useCallback(async (action: () => Promise<unknown>) => {
    if (pending.current) return;
    pending.current = true;
    const token = generation.current;
    setBusy(true);
    setError(null);
    try {
      await transition.current;
      if (!mounted.current || token !== generation.current) return;
      const request = action();
      await request;
    } catch (error) {
      if (mounted.current && token === generation.current)
        setError(
          memoryImportRequestFailureMessage(error) ??
            "Import could not finish. Check the saved result before previewing again.",
        );
    } finally {
      if (mounted.current && token === generation.current) {
        setBusy(false);
        pending.current = false;
      }
    }
  }, []);
  useEffect(() => {
    const retire = async () => {
      generation.current++;
      pending.current = false;
      setBusy(false);
      invalidateSelection();
      // Invalidation fences an admitted reply immediately; clear must settle before rebinding.
      workflow.invalidate();
      transition.current = transition.current.then(() => workflow.removeDestination());
      await transition.current;
    };
    retireRef.current = retire;
    return () => {
      retireRef.current = async () => {};
    };
  }, [workflow, retireRef, invalidateSelection]);
  const recover = useCallback(() => {
    if (["save_failed", "recovery"].includes(workflow.getSnapshot().phase)) return;
    if (!registry.get(memory.importProvider.permissionAtom(params.environmentId)) || !enabled)
      return;
    void run(async () => {
      if (
        await mobileMemoryImportRecovery.load({
          environmentId: params.environmentId,
          memorySpaceId,
        })
      )
        await workflow.recover();
    });
  }, [registry, params.environmentId, memorySpaceId, enabled, run, workflow]);
  useEffect(() => {
    const old = previous.current;
    previous.current = { connection, allowed, enabled, bindingToken, scope };
    const remove =
      (revoked && old.connection === connection && Option.isSome(connection)) ||
      (old.enabled && !enabled) ||
      old.bindingToken !== bindingToken;
    if (remove || old.connection !== connection || old.scope !== scope) {
      generation.current++;
      pending.current = false;
      // The workflow is external mutable state; retire the displayed preview with its fence.
      setBusy(false);
      invalidateSelection();
      workflow.invalidate();
      const nextFence = {
        environmentId: params.environmentId,
        memorySpaceId,
        session: Crypto.randomUUID(),
      };
      transition.current = transition.current.then(async () => {
        if (remove) await workflow.removeDestination();
        workflow.invalidate(nextFence);
      });
      void transition.current
        .then(() => {
          if (mounted.current) {
            recover();
          }
        })
        .catch(() => {
          if (mounted.current)
            setError("Could not clear the previous import. Reopen Settings before importing.");
        });
    } else if (allowed) void Promise.resolve().then(recover);
  }, [
    allowed,
    revoked,
    enabled,
    connection,
    bindingToken,
    scope,
    workflow,
    params.environmentId,
    memorySpaceId,
    recover,
    invalidateSelection,
  ]);
  useFocusEffect(
    useCallback(() => {
      recover();
      const listener = AppState.addEventListener("change", (next) => {
        if (next === "active") recover();
      });
      return () => listener.remove();
    }, [recover]),
  );
  const writable =
    allowed && enabled && !busy && state.phase !== "save_failed" && state.phase !== "recovery";
  const selecting = state.phase === "selecting";
  return (
    <SettingsSection title="Import memories">
      <Copy>
        Import from{" "}
        {formats.includes("aside") ? "Codex, Claude, OMO or Aside" : "Codex, Claude or OMO"}. Other
        provider profiles are not supported. Choose a profile, preview its memories and confirm a
        destination before applying.
        {formats.includes("aside")
          ? " Aside imports only the Current section of each page; project pages need a project scope."
          : ""}
      </Copy>
      <Copy>
        Destination:{" "}
        {savedConnectionsById[params.environmentId]?.environmentLabel ?? "Selected environment"} ·{" "}
        {scope?.kind === "user"
          ? "User memories"
          : scope?.kind === "project"
            ? "Selected project"
            : scope?.kind === "thread"
              ? "Selected thread"
              : "Choose a scope"}
      </Copy>
      {!allowed ? <Copy>Memory write and file read permissions are required.</Copy> : null}
      {formats.map((value) => (
        <Action
          key={value}
          label={`Discover ${memoryImportFormatLabels[value]} profiles`}
          disabled={!writable}
          onPress={() => {
            invalidateSelection();
            setFormat(value);
            void run(async () => {
              const result = await workflow.discover(value);
              if (result) setSources(result);
            });
          }}
        />
      ))}
      {sources?.sources.length === 0 ? <Copy>No supported profiles found.</Copy> : null}
      {sources?.sources.map((source, index) => (
        <Action
          key={source.sourceId}
          label={
            source.format === "aside"
              ? `Preview Aside ${source.label}`
              : `Preview ${format ? memoryImportFormatLabels[format] : ""} profile ${index + 1}`
          }
          disabled={!writable}
          onPress={() => {
            setSelected(new Set());
            setDestinationConfirmed(false);
            void run(async () => {
              const result = await workflow.preview(source.sourceId);
              if (result) setPreview(result);
            });
          }}
        />
      ))}
      {preview ? (
        <>
          <Copy>
            {preview.items.length} memories in this preview. Select the memories to import.
          </Copy>
          {preview.items.map((item, index) => (
            <SettingsSwitchRow
              key={item.sourceItemKey}
              label={
                item.issue
                  ? `${format === "aside" ? item.sourceItemKey : `Memory ${index + 1}`}: ${memoryImportIssueReason(item.issue, "item")}`
                  : (item.title ??
                    (format === "aside" ? item.sourceItemKey : `Memory ${index + 1}`))
              }
              {...(item.tooLargeForTurnStart
                ? { subtitle: "Stored, but too large to add to new turns automatically" }
                : {})}
              value={selected.has(item.sourceItemKey)}
              disabled={!writable || !selecting || !!item.issue || !item.sourceFingerprint}
              onValueChange={(value) =>
                setSelected((old) => {
                  const next = new Set(old);
                  if (value) next.add(item.sourceItemKey);
                  else next.delete(item.sourceItemKey);
                  return next;
                })
              }
            />
          ))}
          <SettingsSwitchRow
            label="Use selected scope and this environment as the import destination"
            value={destinationConfirmed}
            disabled={!writable || !selecting || !scope}
            onValueChange={setDestinationConfirmed}
          />
          <Action
            label="Confirm import selection"
            disabled={
              !writable || !selecting || !scope || !destinationConfirmed || selected.size === 0
            }
            onPress={() => {
              if (!scope) return;
              workflow.select(
                preview.items
                  .filter(
                    (item) =>
                      selected.has(item.sourceItemKey) && item.sourceFingerprint && !item.issue,
                  )
                  .map((item) => ({
                    sourceItemKey: item.sourceItemKey,
                    sourceFingerprint: item.sourceFingerprint!,
                    scope,
                    ...(scope.kind !== "user" && params.project ? { project: params.project } : {}),
                  })),
              );
            }}
          />
          <Action
            label="Apply selected memories"
            disabled={!writable || state.phase !== "previewed"}
            onPress={() => void run(() => workflow.apply())}
          />
          <Action
            label="Change import selection"
            disabled={!writable || selecting}
            onPress={() => {
              workflow.invalidate();
              invalidateSelection();
            }}
          />
        </>
      ) : null}
      {busy ? (
        <Action
          label="Stop import"
          onPress={() => {
            workflow.stop();
          }}
        />
      ) : null}
      <Action
        label="Check saved import result"
        disabled={!allowed || !enabled || busy}
        onPress={() => void run(() => workflow.recover())}
      />
      {state.phase === "save_failed" ? (
        <Action
          label="Retry saving import"
          disabled={!allowed || !enabled || busy}
          onPress={() => void run(() => workflow.retry())}
        />
      ) : null}
      {state.phase === "recovery" ? (
        <Copy>Check the saved import result before continuing.</Copy>
      ) : null}
      {state.message ? <Copy>{state.message}</Copy> : null}
      {state.phase === "completed" ? (
        <Copy>Import completed. Accepted memories may still be processing or waiting to sync.</Copy>
      ) : null}
      {state.phase === "partial" ? (
        <Copy>Import stopped with partial progress. Preview again before importing more.</Copy>
      ) : null}
      {state.receipt ? (
        <Copy>
          {state.receipt.items.length} results in the latest batch; {state.receipt.remaining}{" "}
          remaining. Completed batches: {state.settledChunks}. Accepted items may still be
          processing.
        </Copy>
      ) : null}
      {state.receipt ? (
        <>
          <Copy>Totals across all import batches</Copy>
          {nativeMemoryImportOutcomes(state.totals).map((label) => (
            <Copy key={label}>{label}</Copy>
          ))}
        </>
      ) : null}
      {error ? <Copy>{error}</Copy> : null}
    </SettingsSection>
  );
}
