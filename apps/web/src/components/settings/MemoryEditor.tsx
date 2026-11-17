import { RegistryContext, useAtom, useAtomValue } from "@effect/atom-react";
import {
  type EnvironmentId,
  MemoryId,
  type MemoryItem,
  MemoryOperationId,
  type MemoryScope,
  type MemorySpaceId,
} from "@goat/contracts";
import { memoryScopeLabel } from "@goat/client-runtime/memory-browsing";
import { memoryBodyGap, type MemoryExposure } from "@goat/client-runtime/state/memory";
import { useContext, useEffect, useEffectEvent, useRef, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { memoryEnvironment } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

type ActiveMemoryItem = Extract<MemoryItem, { status: "active" }>;

/** What Save needs from the version an edit started from. It holds no memory text. */
export interface MemoryEditStart {
  readonly memoryId: MemoryId;
  readonly revisionId: ActiveMemoryItem["revision"]["revisionId"];
  readonly scope: MemoryScope;
  readonly assertionKind: ActiveMemoryItem["revision"]["assertionKind"];
  readonly evidence: ActiveMemoryItem["payload"]["evidence"];
  readonly derivedFromMemoryRevisions: ActiveMemoryItem["payload"]["derivedFromMemoryRevisions"];
}

/**
 * The details view's edit across the one-minute body expiry. The shared draft is the only place
 * the text lives: an edit the person changed outlives the expiry, an untouched one closes with the
 * body, and any other gap (another version, a forget, a disconnect) closes it.
 */
export function useMemoryEditSession({
  environmentId,
  memorySpaceId,
  memoryId,
  item,
  canWrite,
  refresh,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  memoryId: MemoryId;
  item: MemoryItem | null;
  canWrite: boolean;
  refresh: () => void;
}) {
  const exposure = useAtomValue(
    memoryEnvironment.exposureAtom({ environmentId, input: { memorySpaceId } }),
  );
  const [seen, setSeen] = useState<MemoryExposure | null>(null);
  if (item && seen !== exposure) setSeen(exposure);
  const gap = item || seen === null ? null : memoryBodyGap(seen, exposure, memoryId);
  const [start, setStart] = useState<MemoryEditStart | null>(null);
  const [edited, setEdited] = useState<"no" | "differs" | "kept">("no");
  // The shared draft decides whether a change keeps the edit; the editor closes when it is gone.
  const draftText = useAtomValue(
    memoryEnvironment.draftAtom({
      environmentId,
      input: { memorySpaceId },
      draftId: `editor:${memoryId}`,
    }),
  );
  const [seeded, setSeeded] = useState(false);
  if (start && !seeded && draftText !== null) setSeeded(true);
  const draftLost = start !== null && seeded && draftText === null;
  // The person's own save, or a read this view asked for, until the next body arrives.
  const [own, setOwn] = useState<"save" | "pending" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  if ((item && own === "pending") || (!start && own === "save")) setOwn(null);
  if (
    start &&
    (!canWrite ||
      (own !== "save" &&
        (draftLost ||
          gap === "forgotten" ||
          gap === "unavailable" ||
          (gap === "unchanged" && edited === "no"))))
  ) {
    setStart(null);
    setSeeded(false);
    // Only an edit the person changed loses anything; an untouched one closes quietly.
    if (canWrite && draftLost && edited !== "no" && gap !== "forgotten" && gap !== "unavailable")
      setNotice(
        "Edit closed because this memory is no longer the version you started from. Your unsaved text was not kept.",
      );
  }
  return {
    gap,
    start,
    notice,
    seenBody: seen !== null,
    ownRequest: own,
    begin(visible: ActiveMemoryItem) {
      // An open edit keeps its starting revision and its edited state until it closes.
      if (start) return;
      setStart({
        memoryId: visible.memoryId,
        revisionId: visible.revision.revisionId,
        scope: visible.scope,
        assertionKind: visible.revision.assertionKind,
        evidence: visible.payload.evidence,
        derivedFromMemoryRevisions: visible.payload.derivedFromMemoryRevisions,
      });
      setEdited("no");
      setSeeded(false);
      setNotice(null);
    },
    close: () => setStart(null),
    showAgain() {
      setOwn("pending");
      refresh();
    },
    editorEvents: {
      edited: edited !== "no",
      // An untouched editor shows the body, so it is masked like the read-only view during a reread.
      masked: own !== "save" && gap === "changed" && edited === "no",
      onTextChange: (text: string) =>
        setEdited((previous) =>
          previous === "kept" || item?.status !== "active"
            ? "kept"
            : text === item.payload.text
              ? "no"
              : "differs",
        ),
      onSaveStart: () => setOwn("save"),
      onSaveSettled: (accepted: boolean) => setOwn(accepted ? "pending" : null),
    },
  };
}

export function MemoryBodyGapNotice({
  session,
}: {
  session: Pick<
    ReturnType<typeof useMemoryEditSession>,
    "gap" | "seenBody" | "ownRequest" | "showAgain"
  >;
}) {
  const showAgain = (
    <Button size="sm" variant="outline" onClick={session.showAgain}>
      Show again
    </Button>
  );
  if (session.ownRequest === "save") return null;
  // A read this view started, or the reread after a change, shows nothing new until it answers.
  if (session.ownRequest === "pending" || session.gap === "changed") return showAgain;
  if (session.gap === "unchanged")
    return (
      <div className="flex flex-wrap items-center gap-2">
        <p role="status">Memory text hidden after a minute.</p>
        {showAgain}
      </div>
    );
  if (session.gap === "unavailable")
    return (
      <p role="status">
        Memory details are unavailable right now. Visible details have been cleared.
      </p>
    );
  return <p role="status">This memory is unavailable. Visible details have been cleared.</p>;
}

const DEFAULT_MEMORY_SCOPE = { kind: "user" } as const;

export function MemoryEditor({
  environmentId,
  memorySpaceId,
  start,
  seedText,
  scope = DEFAULT_MEMORY_SCOPE,
  scopeLabel,
  edited = true,
  masked = false,
  onTextChange,
  onSaveStart,
  onSaveSettled,
  onClose,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  start?: MemoryEditStart;
  /** The visible body that seeds the draft when the editor opens. */
  seedText?: string | undefined;
  scope?: MemoryScope;
  scopeLabel?: string;
  /** An existing memory can be saved only once the draft differs from it. */
  edited?: boolean;
  /** Hides the text while a reread decides whether an untouched edit still stands. */
  masked?: boolean;
  onTextChange?: (text: string) => void;
  onSaveStart?: () => void;
  onSaveSettled?: (accepted: boolean) => void;
  onClose: () => void;
}) {
  const [id] = useState(() => start?.memoryId ?? MemoryId.make(randomUUID()));
  const [operationId, setOperationId] = useState<MemoryOperationId | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = memoryEnvironment.draftAtom({
    environmentId,
    input: { memorySpaceId },
    draftId: `editor:${id}`,
  });
  const [text, setText] = useAtom(draft);
  const registry = useContext(RegistryContext);
  const upsert = useAtomCommand(memoryEnvironment.upsert, { reportFailure: false });
  const canWrite = useAtomValue(memoryEnvironment.upsert.permissionAtom(environmentId));
  const mounted = useRef(true);
  const seed = useEffectEvent(() =>
    seedText !== undefined && start ? { text: seedText, revisionId: start.revisionId } : null,
  );
  // oxlint-disable-next-line goat/react-effect-budget -- the shared draft atom lives outside React; it is seeded on open and cleared on close
  useEffect(() => {
    mounted.current = true;
    const opened = seed();
    if (opened)
      registry.set(draft, {
        text: opened.text,
        memoryIds: [id],
        expectedHeads: [opened.revisionId],
      });
    return () => {
      mounted.current = false;
      registry.set(draft, null);
    };
  }, [draft, id, registry]);
  // A save in flight keeps its form: its own change signal may purge the draft before the reply.
  if (!canWrite || (start && text === null && !busy))
    return (
      <div>
        <p>Editing unavailable. Close this editor and reload the memory.</p>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Close editor
        </Button>
      </div>
    );
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        if (
          busy ||
          masked ||
          !edited ||
          !text?.trim() ||
          !registry.get(memoryEnvironment.upsert.permissionAtom(environmentId))
        )
          return;
        const intentId = operationId ?? MemoryOperationId.make(randomUUID());
        setOperationId(intentId);
        setBusy(true);
        onSaveStart?.();
        const result = await upsert({
          environmentId,
          input: {
            memorySpaceId,
            memoryId: id,
            operationId: intentId,
            expectedHeads: start ? [start.revisionId] : [],
            scope: start?.scope ?? scope,
            assertionKind: start?.assertionKind ?? "fact",
            payload: {
              text,
              evidence: start?.evidence ?? [{ origin: "user", messageIds: [] }],
              derivedFromMemoryRevisions: start?.derivedFromMemoryRevisions ?? [],
            },
            baseBoundary: null,
          },
        });
        if (
          !mounted.current ||
          !registry.get(memoryEnvironment.upsert.permissionAtom(environmentId))
        )
          return;
        setBusy(false);
        const accepted = result._tag === "Success" && result.value.outcome !== "rejected";
        onSaveSettled?.(accepted);
        if (accepted) onClose();
        else
          setError("Memory update failed. Retry the same request or close the editor and reload.");
      }}
    >
      <p>Save to: {scopeLabel ?? memoryScopeLabel(start?.scope ?? scope)}</p>
      <Textarea
        aria-label="Memory text"
        value={masked ? "" : (text ?? "")}
        disabled={masked || busy || operationId !== null}
        onChange={(event) => {
          setText({ text: event.currentTarget.value, memoryIds: start ? [id] : [] });
          onTextChange?.(event.currentTarget.value);
        }}
      />
      {error ? <p role="alert">{error}</p> : null}
      <Button type="submit" size="sm" disabled={busy || masked || !edited || !text?.trim()}>
        {operationId ? "Retry memory request" : "Save memory"}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
    </form>
  );
}
