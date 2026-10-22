import { useAtomValue } from "@effect/atom-react";
import { runAtomCommand } from "@goat/client-runtime/state/runtime";
import type { EnvironmentId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import { workspaceConnections } from "../../state/workspace";
import { environmentCatalog } from "../../connection/catalog";
import { useEnvironmentsWithScope } from "../../state/session";
import { AuthOrchestrationOperateScope } from "@goat/contracts";
import { appAtomRegistry } from "../../state/atom-registry";
import { canEditNoteDraft } from "./notes-model";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useRemoteConnectionStatus } from "../../state/use-remote-environment-registry";
import { deliverNoteWrite } from "./rpc/delivery";
export { notesError } from "./rpc/delivery";
import { notesRpc } from "./rpc/notes";
import { createNotesOutboxController, type NoteDelivery } from "./outbox-controller";
import { notesOutboxStorage } from "./outbox-store";

export const notesOutbox = createNotesOutboxController(notesOutboxStorage);
export const notesCommandOptions = { reportFailure: false, reportDefect: false } as const;

export function useNotesOutbox() {
  return useSyncExternalStore(
    notesOutbox.subscribe,
    notesOutbox.getSnapshot,
    notesOutbox.getSnapshot,
  );
}

export function useNotesPermissions(environmentId: EnvironmentId) {
  const permission = useAtomValue(notesRpc.write.permissionAtom(environmentId));
  return permission;
}

export function useNoteDraftAccess(environmentId: EnvironmentId) {
  const permission = useNotesPermissions(environmentId);
  const runtime = useRemoteEnvironmentRuntime(environmentId);
  const connected = runtime?.connectionState === "connected";
  return {
    canEdit: canEditNoteDraft(permission, connected, runtime !== null),
    canStart: permission && connected,
    connected,
  };
}

export function useNotesFeed(environmentId: EnvironmentId) {
  return useAtomValue(notesRpc.feed({ environmentId, input: {} }));
}

export async function flushNotes(environmentId: EnvironmentId) {
  const canSend = () =>
    appAtomRegistry.get(notesRpc.write.permissionAtom(environmentId)) &&
    appAtomRegistry
      .get(workspaceConnections.environmentsAtom)
      .some(
        (environment) =>
          environment.environmentId === environmentId &&
          environment.connectionState === "connected",
      );
  await notesOutbox.flush(
    environmentId,
    (input): Promise<NoteDelivery> =>
      deliverNoteWrite(
        input,
        async (input) => {
          const result = await runAtomCommand(
            appAtomRegistry,
            notesRpc.write,
            { environmentId, input },
            notesCommandOptions,
          );
          if (AsyncResult.isSuccess(result)) return result.value;
          if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
          throw new Error("The note could not sync.");
        },
        async (path) => {
          const result = await runAtomCommand(
            appAtomRegistry,
            notesRpc.read,
            { environmentId, input: { path } },
            notesCommandOptions,
          );
          if (AsyncResult.isSuccess(result)) return result.value;
          if (AsyncResult.isFailure(result)) throw Cause.squash(result.cause);
          throw new Error("The hub's version could not be loaded.");
        },
      ),
    canSend,
    Option.getOrNull(
      AsyncResult.value(appAtomRegistry.get(environmentCatalog.stateAtom(environmentId))),
    )?.generation ?? 0,
  );
}

export function useNotesOutboxWorker() {
  const { connectedEnvironments } = useRemoteConnectionStatus();
  const permitted = useEnvironmentsWithScope(connectedEnvironments, AuthOrchestrationOperateScope);
  // A scalar key keeps stream-driven shell updates from triggering redundant flushes.
  const connected = connectedEnvironments
    .filter(
      (environment) =>
        environment.connectionState === "connected" && permitted.has(environment.environmentId),
    )
    .map((environment) => environment.environmentId)
    .sort()
    .join("\n");
  useEffect(() => {
    const flush = () => {
      void notesOutbox
        .restore()
        .then(async () => {
          for (const id of connected.split("\n").filter(Boolean))
            await flushNotes(id as EnvironmentId);
        })
        .catch((error: unknown) => console.warn("[notes] outbox unavailable", error));
    };
    flush();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") flush();
    });
    return () => subscription.remove();
  }, [connected]);
}
