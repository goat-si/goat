import { squashAtomCommandFailure } from "@goat/client-runtime/state/runtime";
import { AuthFilesystemWriteScope, type EnvironmentId } from "@goat/contracts";
import { createRef, useEffect, useState, useSyncExternalStore } from "react";

import { projectEnvironment } from "~/state/projects";
import { readEnvironmentScope, useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { FileSaveCoordinator } from "./fileSaveCoordinator";
import {
  confirmProjectFileQueryData,
  getProjectFileSaveSession,
  getUnsavedProjectFileQueryData,
  getProjectFileData,
  reloadProjectFileData,
} from "./projectFilesQueryState";

const FILE_SAVE_DEBOUNCE_MS = 500;

interface FileSaveOptions {
  environmentId: EnvironmentId;
  cwd: string;
  relativePath: string;
  onPendingChange: (relativePath: string, pending: boolean) => void;
}

export function useFileSaveCoordinator({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
}: FileSaveOptions) {
  const fileSession = getProjectFileSaveSession(environmentId, cwd, relativePath);
  const status = useSyncExternalStore(fileSession.subscribe, fileSession.getStatus);
  const canWriteFiles = useEnvironmentScope(environmentId, AuthFilesystemWriteScope);
  const writeFile = useProjectFileWriter();
  const inputs = { environmentId, cwd, relativePath, onPendingChange, writeFile, fileSession };
  const [current, setCurrent] = useState(() => ({
    inputs,
    session: createFileSaveSession(inputs),
  }));
  if (
    current.inputs.environmentId !== environmentId ||
    current.inputs.cwd !== cwd ||
    current.inputs.relativePath !== relativePath ||
    current.inputs.onPendingChange !== onPendingChange ||
    current.inputs.writeFile !== writeFile ||
    current.inputs.fileSession !== fileSession
  ) {
    setCurrent({ inputs, session: createFileSaveSession(inputs) });
  }
  const session = current.session;

  // StrictMode replay needs a fresh coordinator; retired file sessions stay inert.
  useEffect(session.setup, [session]);
  useEffect(() => {
    if (!canWriteFiles) return;
    let cancelled = false;
    // Replay must retire the first session before recovery queues a draft to flush.
    queueMicrotask(() => {
      if (cancelled) return;
      const unsaved = getUnsavedProjectFileQueryData(environmentId, cwd, relativePath);
      if (unsaved) session.change(unsaved.contents);
    });
    return () => {
      cancelled = true;
    };
  }, [canWriteFiles, cwd, environmentId, relativePath, session]);
  return { ...session, status, canWriteFiles };
}

function useProjectFileWriter() {
  return useAtomCommand(projectEnvironment.writeFile);
}

function createFileSaveSession({
  environmentId,
  cwd,
  relativePath,
  onPendingChange,
  writeFile,
  fileSession,
}: FileSaveOptions & {
  fileSession: ReturnType<typeof getProjectFileSaveSession>;
  writeFile: ReturnType<typeof useProjectFileWriter>;
}) {
  const coordinatorRef = createRef<FileSaveCoordinator>();
  const persistence = { confirmed: true };
  const setStatus = (next: Parameters<typeof fileSession.setStatus>[0]) =>
    fileSession.setStatus(next);
  return {
    retry: () => coordinatorRef.current?.retry(),
    overwrite: () => {
      if (!fileSession.requestOverwrite()) return;
      coordinatorRef.current?.retry();
    },
    reload: async () => {
      if (!fileSession.blocked) return;
      setStatus("reloading");
      const result = await fileSession.enqueue(() =>
        reloadProjectFileData(environmentId, cwd, relativePath),
      );
      if (result._tag !== "Success") setStatus("reloadFailed");
    },
    change: (contents: string) => coordinatorRef.current?.change(contents),
    setup: () => {
      const coordinator = new FileSaveCoordinator({
        debounceMs: FILE_SAVE_DEBOUNCE_MS,
        canPersist: () =>
          !fileSession.blocked && readEnvironmentScope(environmentId, AuthFilesystemWriteScope),
        onPendingChange: (pending) => {
          onPendingChange(relativePath, pending);
          if (!fileSession.blocked) setStatus(pending ? "unsaved" : "saved");
        },
        persist: (nextContents) => {
          const generation = fileSession.generation;
          return fileSession.enqueue(async () => {
            if (
              generation !== fileSession.generation ||
              fileSession.blocked ||
              !readEnvironmentScope(environmentId, AuthFilesystemWriteScope)
            )
              return null;
            const baseline = getProjectFileData(environmentId, cwd, relativePath);
            const expectedVersion = fileSession.takeOverwrite() ? undefined : baseline?.version;
            setStatus("saving");
            const result = await writeFile({
              environmentId,
              input: {
                cwd,
                relativePath,
                contents: nextContents,
                ...(expectedVersion !== undefined ? { expectedVersion } : {}),
                ...(baseline?.textFormat ? { textFormat: baseline.textFormat } : {}),
              },
            });
            if (result._tag === "Success") {
              // Advance the baseline before a serialized follow-up, including
              // when newer edits prevent this write from clearing the draft.
              persistence.confirmed =
                confirmProjectFileQueryData(
                  environmentId,
                  cwd,
                  relativePath,
                  nextContents,
                  result.value,
                ) !== false;
              if (!persistence.confirmed) setStatus("unsaved");
            } else {
              const failure = squashAtomCommandFailure(result);
              const kind =
                failure && typeof failure === "object" && "failure" in failure
                  ? failure.failure
                  : undefined;
              setStatus(
                kind === "changed_on_disk"
                  ? "changed"
                  : kind === "deleted_on_disk"
                    ? "deleted"
                    : "failed",
              );
            }
            return result;
          });
        },
        onConfirmed: () => persistence.confirmed,
      });
      coordinatorRef.current = coordinator;
      fileSession.coordinators.add(coordinator);
      return () => {
        coordinatorRef.current = null;
        coordinator.dispose();
        fileSession.coordinators.delete(coordinator);
      };
    },
  };
}
