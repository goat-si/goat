import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  MemoryOperationId,
  type EnvironmentId,
  type MemoryId,
  type MemorySpaceId,
} from "@goat/contracts";
import {
  canSubmitMemoryMove,
  memoryMoveOutcomeMessage,
  memoryMoveRows,
  submitMemoryMoves,
  type MemoryMoveAttempts,
  type MemoryMoveCandidate,
} from "@goat/client-runtime/memory-browsing";
import { useContext, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { memoryEnvironment as memory } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { MemoryScopeSettings, type MemoryScopeSelection } from "./MemoryScopeSettings";

export function MemoryMoveControl({
  environmentId,
  memorySpaceId,
  candidates,
  admitted,
  isCurrent,
  onMoved,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  candidates: readonly MemoryMoveCandidate[];
  admitted?: ReadonlySet<MemoryId>;
  isCurrent?: (candidate: MemoryMoveCandidate) => boolean;
  onMoved: (allMoved: boolean) => void;
}) {
  const registry = useContext(RegistryContext);
  const permission = memory.move.permissionAtom(environmentId);
  const allowed = useAtomValue(permission);
  const move = useAtomCommand(memory.move, { reportFailure: false, reportDefect: false });
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState<MemoryScopeSelection | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempts, setAttempts] = useState<MemoryMoveAttempts>(() => new Map());
  if (!allowed || !candidates.length) return null;
  const rows = memoryMoveRows(environmentId, candidates, selection?.scope, attempts);
  const eligible = rows.filter(
    (row) => canSubmitMemoryMove(row) && (!admitted || admitted.has(row.input.memoryId)),
  ).length;
  async function submit() {
    const permitted = () => registry.get(permission);
    if (busy || !eligible || !permitted()) return;
    setBusy(true);
    const result = await submitMemoryMoves(
      rows,
      () => MemoryOperationId.make(randomUUID()),
      (input) => move({ environmentId, input }),
      (candidate) => permitted() && (isCurrent?.(candidate) ?? true),
    );
    setBusy(false);
    setAttempts(result.attempts);
    if (!permitted()) return;
    if (result.allMoved) setOpen(false);
    if (result.refresh) onMoved(result.allMoved);
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
        <Button size="sm" disabled={busy || !eligible} onClick={() => void submit()}>
          {eligible > 1 ? `Move ${eligible} memories` : "Move memory"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setOpen(false);
            setSelection(null);
          }}
        >
          Cancel
        </Button>
      </div>
      <div role="status">
        {rows.map(
          ({ input, label, outcome }) =>
            outcome && (
              <p key={input.memoryId}>
                {rows.length > 1 ? `${label} · ` : ""}
                {memoryMoveOutcomeMessage(outcome)}
              </p>
            ),
        )}
      </div>
    </div>
  ) : (
    <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
      Move to…
    </Button>
  );
}
