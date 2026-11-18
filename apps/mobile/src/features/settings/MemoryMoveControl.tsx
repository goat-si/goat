import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MemoryScope, MemorySpaceId } from "@goat/contracts";
import {
  memoryProjectScope,
  canSubmitMemoryMove,
  memoryMoveOutcomeMessage,
  memoryMoveRows,
  submitMemoryMoves,
  type MemoryMoveAttempts,
  type MemoryMoveCandidate,
} from "@goat/client-runtime/memory-browsing";
import { useContext, useState } from "react";
import { Pressable } from "react-native";
import { Menu } from "../../components/ui/Menu";
import { useProjects, useThreadShells } from "../../state/entities";
import { memoryEnvironment as memory } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { useMemoryLifetime } from "./MemoryGenerationSettings";
import { Action, Copy, operationId } from "./memoryScreenParts";

export function MobileMemoryMoveControl({
  environmentId,
  memorySpaceId,
  candidates,
  onMoved,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  candidates: readonly MemoryMoveCandidate[];
  onMoved: (allMoved: boolean) => void;
}) {
  const permission = memory.move.permissionAtom(environmentId);
  const allowed = useAtomValue(permission);
  const registry = useContext(RegistryContext);
  const live = useMemoryLifetime(environmentId);
  const move = useAtomCommand(memory.move, { reportFailure: false, reportDefect: false });
  const getProject = useAtomCommand(memory.projectBindingGet);
  const projects = useProjects().filter((item) => item.environmentId === environmentId);
  const threads = useThreadShells().filter((item) => item.environmentId === environmentId);
  const [destination, setDestination] = useState<{ scope: MemoryScope; label: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [attempts, setAttempts] = useState<MemoryMoveAttempts>(() => new Map());
  if (!allowed || !candidates.length) return null;

  const actions = [
    { id: "user", title: "All projects" },
    ...projects.map((p) => ({ id: `project:${p.id}`, title: p.title })),
    ...threads.map((t) => ({ id: `thread:${t.id}`, title: t.title })),
  ];
  async function choose(key: string) {
    if (busy || !live() || !registry.get(permission)) return;
    setMessage(null);
    setDestination(null);
    if (key === "user") {
      setDestination({ scope: { kind: "user" }, label: "All projects" });
      return;
    }
    const thread = threads.find((t) => `thread:${t.id}` === key);
    if (thread) {
      setDestination({
        scope: { kind: "thread", thread: { environmentId, threadId: thread.id } },
        label: thread.title,
      });
      return;
    }
    const project = projects.find((item) => `project:${item.id}` === key);
    if (!project) return;
    setBusy(true);
    const result = await getProject({
      environmentId,
      input: {
        memorySpaceId,
        project: { environmentId, projectId: project.id },
      },
    });
    if (!live()) return;
    setBusy(false);
    if (!registry.get(permission)) return;
    const scope =
      result._tag === "Success"
        ? memoryProjectScope(result.value, project.repositoryIdentity)
        : null;
    if (scope) setDestination({ scope, label: project.title });
    else setMessage("This project has no memory scope.");
  }
  const rows = memoryMoveRows(environmentId, candidates, destination?.scope, attempts);
  const eligible = rows.filter(canSubmitMemoryMove).length;
  async function submit() {
    const permitted = () => live() && registry.get(permission);
    if (!eligible || busy || !permitted()) return;
    setBusy(true);
    const result = await submitMemoryMoves(
      rows,
      operationId,
      (input) => move({ environmentId, input }),
      permitted,
    );
    if (!live()) return;
    setBusy(false);
    setAttempts(result.attempts);
    if (!permitted()) return;
    if (result.allMoved) setDestination(null);
    if (result.refresh) onMoved(result.allMoved);
  }

  return (
    <>
      <Menu actions={actions} onPressAction={({ nativeEvent }) => void choose(nativeEvent.event)}>
        <Pressable accessibilityRole="button" accessibilityLabel="Move to…" disabled={busy}>
          <Copy>Move to…</Copy>
        </Pressable>
      </Menu>
      {destination ? (
        <>
          <Copy>{`Destination: ${destination.label}`}</Copy>
          <Action
            label={eligible > 1 ? `Move ${eligible} memories` : "Move memory"}
            disabled={busy || !eligible}
            onPress={() => void submit()}
          />
          <Action label="Cancel move" disabled={busy} onPress={() => setDestination(null)} />
          {rows.map(
            ({ input, label, outcome }) =>
              outcome && (
                <Copy key={input.memoryId}>
                  {rows.length > 1 ? `${label} · ` : ""}
                  {memoryMoveOutcomeMessage(outcome)}
                </Copy>
              ),
          )}
        </>
      ) : null}
      {message ? <Copy>{message}</Copy> : null}
    </>
  );
}
