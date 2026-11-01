import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  MemoryOperationId,
  type EnvironmentId,
  type MemorySpaceId,
  type MemoryProjectBinding,
  type MemoryScope,
  type ScopedProjectRef,
} from "@goat/contracts";
import { useContext, useEffect, useRef, useState } from "react";
import { useProjects, useThreadShells } from "../../state/entities";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { removeMemoryImportDestination } from "../../lib/memoryImportRecoveryStorage";
import { randomUUID } from "../../lib/utils";
import { MemoryScopePicker } from "./MemoryScopePicker";
import { Button } from "../ui/button";
import { Select, SelectTrigger, SelectValue, SelectPopup, SelectItem } from "../ui/select";

export type MemoryScopeSelection = { scope: MemoryScope; project?: ScopedProjectRef };

/** Destination choices use environment-local records, never inherited settings filters. */
export function MemoryScopeSettings({
  environmentId,
  memorySpaceId,
  disabled = false,
  onChange,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  disabled?: boolean;
  onChange: (selection: MemoryScopeSelection | null) => void;
}) {
  const registry = useContext(RegistryContext);
  const projects = useProjects().filter((p) => p.environmentId === environmentId);
  const [kind, setKind] = useState<MemoryScope["kind"] | null>(null);
  const threads = useThreadShells(kind === "thread").filter(
    (t) => t.environmentId === environmentId,
  );
  const [projectId, setProjectId] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [binding, setBinding] = useState<MemoryProjectBinding | null>(null);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<"setExplicit" | "useRepository" | null>(null);
  const canGet = useAtomValue(memoryEnvironment.projectBindingGet.permissionAtom(environmentId));
  const canUpdate = useAtomValue(
    memoryEnvironment.projectBindingUpdate.permissionAtom(environmentId),
  );
  const get = useAtomCommand(memoryEnvironment.projectBindingGet, { reportFailure: false });
  const update = useAtomCommand(memoryEnvironment.projectBindingUpdate, { reportFailure: false });
  const project = projects.find((p) => p.id === projectId);
  const selectedThreadId = threads.find((t) => t.id === threadId)?.id;
  const generation = useRef(0);
  // A destination or grant change invalidates the previous remote binding.
  const [request, setRequest] = useState({ project, environmentId, memorySpaceId, canGet, reload });
  if (
    request.project !== project ||
    request.environmentId !== environmentId ||
    request.memorySpaceId !== memorySpaceId ||
    request.canGet !== canGet ||
    request.reload !== reload
  ) {
    setRequest({ project, environmentId, memorySpaceId, canGet, reload });
    setBinding(null);
    setBusy(false);
    setConfirm(null);
    setMessage(null);
  }
  useEffect(() => {
    const token = ++generation.current;
    const requested = request.project;
    if (requested && request.canGet)
      void get({
        environmentId: request.environmentId,
        input: {
          memorySpaceId: request.memorySpaceId,
          project: { environmentId: request.environmentId, projectId: requested.id },
        },
      }).then((result) => {
        if (token !== generation.current) return;
        if (result._tag === "Success") setBinding(result.value);
        else setMessage("Could not load project binding. Reload before changing it.");
      });
    return () => {
      generation.current++;
    };
  }, [request, get]);
  useEffect(() => {
    onChange(
      kind === "user"
        ? { scope: { kind: "user" } }
        : kind === "project" &&
            project &&
            binding?.project.projectId === project.id &&
            binding.projectKey
          ? {
              scope: { kind: "project", projectKey: binding.projectKey },
              project: { environmentId, projectId: project.id },
            }
          : kind === "thread" && selectedThreadId
            ? { scope: { kind: "thread", thread: { environmentId, threadId: selectedThreadId } } }
            : null,
    );
  }, [kind, project, binding, selectedThreadId, environmentId, onChange]);
  async function save() {
    if (
      !confirm ||
      !binding ||
      busy ||
      !registry.get(memoryEnvironment.projectBindingUpdate.permissionAtom(environmentId))
    )
      return;
    const token = generation.current;
    setBusy(true);
    const base = {
      memorySpaceId,
      project: binding.project,
      requestId: MemoryOperationId.make(randomUUID()),
      expectedVersion: binding.version,
    };
    try {
      await removeMemoryImportDestination({ environmentId, memorySpaceId });
    } catch {
      if (token === generation.current) {
        setBusy(false);
        setMessage("Could not stop import selection. Binding was not changed.");
      }
      return;
    }
    if (
      token !== generation.current ||
      !registry.get(memoryEnvironment.projectBindingUpdate.permissionAtom(environmentId))
    ) {
      setBusy(false);
      return;
    }
    const result = await update({
      environmentId,
      input:
        confirm === "setExplicit"
          ? { ...base, action: "setExplicit", sharedProjectId: randomUUID() }
          : { ...base, action: "useRepository" },
    });
    if (token !== generation.current) return;
    setBusy(false);
    setConfirm(null);
    if (result._tag === "Success") {
      setBinding(result.value.binding);
      setMessage("Project binding updated.");
    } else {
      setBinding(null);
      setMessage("Project binding changed or the request failed. Reload before trying again.");
    }
  }
  return (
    <div className="space-y-3">
      <Select
        value={kind}
        disabled={disabled || busy}
        onValueChange={(value) => {
          setKind(value);
          setConfirm(null);
        }}
      >
        <SelectTrigger aria-label="Memory scope">
          <SelectValue placeholder="Choose memory scope" />
        </SelectTrigger>
        <SelectPopup>
          {(["user", "project", "thread"] as const).map((value) => (
            <SelectItem key={value} value={value}>
              {value === "user" ? "All projects" : value === "project" ? "Project" : "Thread"}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {kind === "project" ? (
        <>
          <MemoryScopePicker
            items={projects}
            value={projectId}
            disabled={disabled || busy}
            onChange={setProjectId}
            label="Memory project"
          />
          {binding ? (
            <p className="text-xs leading-normal text-muted-foreground/80">
              {binding.projectKey?.kind === "explicit"
                ? "Dedicated shared project"
                : binding.projectKey
                  ? "Uses repository identity"
                  : "No repository identity available"}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={disabled || busy || !canUpdate || !binding}
              onClick={() =>
                setConfirm(
                  binding?.projectKey?.kind === "explicit" ? "useRepository" : "setExplicit",
                )
              }
            >
              {binding?.projectKey?.kind === "explicit"
                ? "Use repository identity"
                : "Create dedicated shared project"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={disabled || busy}
              onClick={() => setReload((v) => v + 1)}
            >
              Reload binding
            </Button>
          </div>
          {confirm ? (
            <div className="space-y-3" role="group" aria-label="Confirm project binding">
              <p className="text-xs leading-normal text-muted-foreground/80">
                Change the project identity used for future memories? Existing memories keep their
                scope.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" disabled={disabled || busy} onClick={() => void save()}>
                  Confirm binding change
                </Button>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </>
      ) : null}
      {kind === "thread" ? (
        <MemoryScopePicker
          items={threads}
          value={threadId}
          disabled={disabled || busy}
          onChange={setThreadId}
          label="Memory thread"
        />
      ) : null}
      {message ? (
        <p className="text-xs leading-normal text-muted-foreground/80" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}
