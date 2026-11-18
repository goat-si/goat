import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  MemoryOperationId,
  type EnvironmentId,
  type MemoryMoveInput,
  type MemorySpaceId,
} from "@goat/contracts";
import { sameMemoryScope, type MemoryMoveCandidate } from "@goat/client-runtime/memory-browsing";
import { useContext, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { memoryEnvironment as memory } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MemoryScopeSettings, type MemoryScopeSelection } from "./MemoryScopeSettings";

export function MemoryMoveControl({
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
  const registry = useContext(RegistryContext);
  const permission = memory.move.permissionAtom(environmentId);
  const allowed = useAtomValue(permission);
  const move = useAtomCommand(memory.move);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<MemoryScopeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(0);
  const attempt = useRef<{ key: string; requests: readonly MemoryMoveInput[] } | null>(null);
  if (!allowed || !candidates.length) return null;
  const destination = selection?.scope;
  const eligible = destination
    ? candidates.filter((item) => !sameMemoryScope(item.fromScope, destination))
    : [];
  async function submit() {
    if (busy || !destination || !eligible.length || !registry.get(permission)) return;
    const key = JSON.stringify([destination, eligible]);
    if (attempt.current?.key !== key)
      attempt.current = {
        key,
        requests: eligible.map((input) => ({
          ...input,
          operationId: MemoryOperationId.make(randomUUID()),
          toScope: destination,
        })),
      };
    setBusy(true);
    const failures: MemoryMoveInput[] = [];
    const { requests } = attempt.current;
    for (const input of requests) {
      if (!registry.get(permission)) break;
      const result = await move({ environmentId, input });
      if (
        result._tag !== "Success" ||
        result.value.outcome !== "accepted" ||
        result.value.pendingSync
      )
        failures.push(input);
    }
    setBusy(false);
    if (!registry.get(permission)) return;
    attempt.current = failures.length ? { key, requests: failures } : null;
    setFailed(failures.length);
    if (failures.length === 0) setOpen(false);
    if (failures.length < requests.length) onMoved(failures.length === 0);
  }
  return open ? (
    <div className="space-y-2" role="group" aria-label="Move memories">
      <MemoryScopeSettings
        environmentId={environmentId}
        memorySpaceId={memorySpaceId}
        disabled={busy}
        bindingControls={false}
        onChange={setSelection}
      />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy || !eligible.length} onClick={() => void submit()}>
          {eligible.length > 1 ? `Move ${eligible.length} memories` : "Move memory"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setSelection(null);
            setFailed(0);
          }}
        >
          Cancel
        </Button>
      </div>
      {failed ? (
        <p role="status">
          Could not confirm the move for {failed} {failed === 1 ? "memory" : "memories"}.
        </p>
      ) : null}
    </div>
  ) : (
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
      Move to…
    </Button>
  );
}
