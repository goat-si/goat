import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, MemoryMoveInput, MemoryScope, MemorySpaceId } from "@goat/contracts";
import {
  memoryProjectScope,
  sameMemoryScope,
  type MemoryMoveCandidate,
} from "@goat/client-runtime/memory-browsing";
import { useContext, useRef, useState } from "react";
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
  const move = useAtomCommand(memory.move);
  const getProject = useAtomCommand(memory.projectBindingGet);
  const projects = useProjects().filter((item) => item.environmentId === environmentId);
  const threads = useThreadShells().filter((item) => item.environmentId === environmentId);
  const [destination, setDestination] = useState<{ scope: MemoryScope; label: string } | null>(
    null,
  );
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempts = useRef<{ key: string; requests: readonly MemoryMoveInput[] } | null>(null);
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
  const eligible = destination
    ? candidates.filter((item) => !sameMemoryScope(item.fromScope, destination.scope))
    : [];
  async function submit() {
    if (!destination || !eligible.length || busy || !live() || !registry.get(permission)) return;
    const key = JSON.stringify([destination.scope, eligible]);
    if (attempts.current?.key !== key)
      attempts.current = {
        key,
        requests: eligible.map((input) => ({
          ...input,
          operationId: operationId(),
          toScope: destination.scope,
        })),
      };
    const { requests } = attempts.current;
    setBusy(true);
    const failures: MemoryMoveInput[] = [];
    for (const input of requests) {
      if (!live() || !registry.get(permission)) return;
      const result = await move({ environmentId, input });
      if (
        result._tag !== "Success" ||
        result.value.outcome !== "accepted" ||
        result.value.pendingSync
      )
        failures.push(input);
    }
    if (!live()) return;
    setBusy(false);
    if (!registry.get(permission)) return;
    attempts.current = failures.length ? { key, requests: failures } : null;
    setMessage(
      failures.length
        ? `Could not confirm the move for ${failures.length} ${failures.length === 1 ? "memory" : "memories"}.`
        : null,
    );
    if (!failures.length) setDestination(null);
    if (failures.length < requests.length) onMoved(failures.length === 0);
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
            label={eligible.length > 1 ? `Move ${eligible.length} memories` : "Move memory"}
            disabled={busy || !eligible.length}
            onPress={() => void submit()}
          />
          <Action label="Cancel move" disabled={busy} onPress={() => setDestination(null)} />
        </>
      ) : null}
      {message ? <Copy>{message}</Copy> : null}
    </>
  );
}
