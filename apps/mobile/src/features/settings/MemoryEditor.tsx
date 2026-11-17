import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  MemoryId,
  type MemoryOperationId,
  type MemoryScope,
  type MemorySpaceId,
} from "@goat/contracts";
import { memoryScopeLabel } from "@goat/client-runtime/memory-browsing";
import { AsyncResult } from "effect/reactivity";
import { useContext, useEffect, useEffectEvent, useMemo, useRef, useState } from "react";
import * as Crypto from "expo-crypto";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { memoryEnvironment as memory } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Action, Copy, Field, failureMessage, operationId } from "./memoryScreenParts";
import { memoryDraftId, type MemoryEditStart } from "./useMemoryEditSession";

/** Edits an existing memory from start, or writes a new one when there is no start. */
export function MemoryEditor({
  environmentId,
  memorySpaceId,
  scope,
  scopeLabel,
  start,
  seedText,
  edited = true,
  masked = false,
  onTextChange,
  onSaveStart,
  onSaveSettled,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly memorySpaceId: MemorySpaceId;
  readonly scope: MemoryScope;
  readonly scopeLabel?: string;
  readonly start?: MemoryEditStart;
  /** The visible body that seeds the draft when the editor opens. */
  readonly seedText?: string;
  /** An existing memory can be saved only once the draft differs from it. */
  readonly edited?: boolean;
  /** Hides the text while a reread decides whether an untouched edit still stands. */
  readonly masked?: boolean;
  readonly onTextChange?: (text: string) => void;
  readonly onSaveStart?: () => void;
  readonly onSaveSettled?: (accepted: boolean) => void;
  readonly onClose: () => void;
}) {
  const registry = useContext(RegistryContext);
  const [id] = useState(() => start?.memoryId ?? MemoryId.make(Crypto.randomUUID()));
  const draftAtom = useMemo(
    () =>
      memory.draftAtom({
        environmentId,
        input: { memorySpaceId },
        draftId: memoryDraftId(id),
      }),
    [environmentId, memorySpaceId, id],
  );
  const text = useAtomValue(draftAtom);
  const setDraft = useAtomSet(draftAtom);
  const allowed = useAtomValue(memory.upsert.permissionAtom(environmentId));
  const upsert = useAtomCommand(memory.upsert);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const intent = useRef<MemoryOperationId | null>(null);
  const [retry, setRetry] = useState(false);
  const busy = useRef(false);
  const mounted = useRef(true);
  const seed = useEffectEvent(() =>
    start && seedText !== undefined
      ? { text: seedText, memoryIds: [id], expectedHeads: [start.revisionId] }
      : { text: "", memoryIds: [] },
  );
  // oxlint-disable-next-line goat/react-effect-budget -- the shared draft atom lives outside React; it is seeded once on open with the starting version and cleared on close
  useEffect(() => {
    mounted.current = true;
    registry.set(draftAtom, seed());
    return () => {
      mounted.current = false;
      registry.set(draftAtom, null);
    };
  }, [registry, draftAtom]);
  async function save() {
    const current = registry.get(draftAtom);
    if (
      masked ||
      !edited ||
      !current?.trim() ||
      busy.current ||
      !registry.get(memory.upsert.permissionAtom(environmentId))
    )
      return;
    if (intent.current === null) intent.current = operationId();
    const requested = intent.current;
    busy.current = true;
    setPending(true);
    setError(null);
    onSaveStart?.();
    // The command reports a failed request in its result; it does not throw.
    const result = await upsert({
      environmentId,
      input: {
        memorySpaceId,
        operationId: requested,
        memoryId: id,
        expectedHeads: start ? [start.revisionId] : [],
        scope: start?.scope ?? scope,
        assertionKind: start?.assertionKind ?? "fact",
        payload: {
          text: current,
          evidence: start?.evidence ?? [{ origin: "user", messageIds: [] }],
          derivedFromMemoryRevisions: start?.derivedFromMemoryRevisions ?? [],
        },
        baseBoundary: null,
      },
    });
    busy.current = false;
    // Its own change signal may have dropped the draft already; the reply still decides.
    if (!mounted.current) return;
    setPending(false);
    if (!registry.get(memory.upsert.permissionAtom(environmentId))) return;
    if (AsyncResult.isSuccess(result)) {
      setError(
        `Request ${result.value.outcome}${result.value.pendingSync ? " · Propagation pending" : ""}`,
      );
      intent.current = null;
      const accepted = result.value.outcome === "accepted" || result.value.outcome === "noop";
      onSaveSettled?.(accepted);
      if (accepted) onClose();
    } else if (AsyncResult.isFailure(result)) {
      onSaveSettled?.(false);
      setRetry(true);
      setError(`${failureMessage(result)} Retry uses the same request.`);
    }
  }
  return (
    <ScreenScrollView contentInsetAdjustmentBehavior="automatic">
      <Action label="Close editor" onPress={onClose} />
      <Copy>Save to: {scopeLabel ?? memoryScopeLabel(start?.scope ?? scope)}</Copy>
      {text === null && !pending ? (
        <Copy>The draft is no longer available. Close and reopen this memory.</Copy>
      ) : (
        <>
          <Field
            label="Memory text"
            value={masked ? "" : (text ?? "")}
            onChange={(value) => {
              setDraft({ text: value, memoryIds: start ? [id] : [] });
              onTextChange?.(value);
            }}
            disabled={masked || pending || retry || !allowed}
            multiline
          />
          <Action
            label={retry ? "Retry save request" : "Save memory"}
            onPress={() => void save()}
            disabled={!allowed || pending || masked || !edited || !text?.trim()}
          />
        </>
      )}
      {error ? <Copy>{error}</Copy> : null}
    </ScreenScrollView>
  );
}
