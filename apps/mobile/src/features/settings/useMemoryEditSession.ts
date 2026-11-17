import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MemoryId,
  MemoryItem,
  MemoryScope,
  MemorySpaceId,
} from "@goat/contracts";
import { memoryBodyGap, type MemoryExposure } from "@goat/client-runtime/state/memory";
import { useState } from "react";
import { memoryEnvironment as memory } from "../../state/memory";

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

export const memoryDraftId = (memoryId: MemoryId) => `native:${memoryId}`;

export const MEMORY_EDIT_CLOSED =
  "Edit closed because this memory is no longer the version you started from. Your unsaved text was not kept.";

/**
 * The details view's edit across the one-minute body expiry. The edit snapshot holds no text; the
 * shared draft holds the typing and the text it started from. An edit the person changed outlives
 * the expiry, an untouched one closes with the body, and the shared draft decides any other change.
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
  const exposure = useAtomValue(memory.exposureAtom({ environmentId, input: { memorySpaceId } }));
  const [seen, setSeen] = useState<MemoryExposure | null>(null);
  if (item && seen !== exposure) setSeen(exposure);
  // Null while a read is still in flight: an empty body then is not the one-minute expiry.
  const reply = useAtomValue(
    memory.read.reply({ environmentId, input: { memorySpaceId, memoryId } }),
  );
  const found = item || seen === null ? null : memoryBodyGap(seen, exposure, memoryId);
  const gap = found === "unchanged" && reply === null ? null : found;
  const [start, setStart] = useState<MemoryEditStart | null>(null);
  const [edited, setEdited] = useState<"no" | "differs" | "kept">("no");
  // The shared draft decides whether a change keeps the edit; the editor closes when it is gone.
  const draftText = useAtomValue(
    memory.draftAtom({
      environmentId,
      input: { memorySpaceId },
      draftId: memoryDraftId(memoryId),
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
      setNotice(MEMORY_EDIT_CLOSED);
  }
  return {
    gap,
    start,
    notice,
    seenBody: seen !== null,
    ownRequest: own,
    begin(visible: ActiveMemoryItem) {
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
    editor: {
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

/** What the details show where the body was: a line, a Show again button, or both. */
export function memoryBodyGapNotice(
  session: Pick<ReturnType<typeof useMemoryEditSession>, "gap" | "ownRequest">,
): { readonly line: string | null; readonly showAgain: boolean } {
  if (session.ownRequest === "save") return { line: null, showAgain: false };
  // A read this view started, or the reread after a change, shows nothing new until it answers.
  if (session.ownRequest === "pending" || session.gap === "changed")
    return { line: null, showAgain: true };
  if (session.gap === "unchanged")
    return { line: "Memory text hidden after a minute.", showAgain: true };
  if (session.gap === "unavailable")
    return {
      line: "Memory details are unavailable right now. Visible details have been cleared.",
      showAgain: false,
    };
  return {
    line: "This memory is unavailable. Visible details have been cleared.",
    showAgain: false,
  };
}
