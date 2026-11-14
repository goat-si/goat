import { goatBotItemReaders, type GoatBotRow } from "@goat/client-runtime/goatBot";
import type { OrchestrationV2ProjectedTurnItem } from "@goat/contracts";
import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface GoatBotLocalSubmission {
  readonly key: string;
}

export function localSendRows(items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>) {
  const result = new Map<string, string>();
  for (const { item } of items) {
    if (item.type !== "user_message") continue;
    const key = goatBotItemReaders.message(item)?.clientKey;
    if (key) result.set(key, item.id);
  }
  return result;
}

export function useGoatBotFollow({
  rows,
  baselineIds,
  sourceIds,
  submissions,
  committedSends,
  scrollRef,
  listRef,
  followingRef,
  lastScrollTopRef,
  onExposure,
}: {
  readonly rows: ReadonlyArray<GoatBotRow>;
  readonly baselineIds: ReadonlySet<string> | null | undefined;
  readonly sourceIds: ReadonlySet<string> | undefined;
  readonly submissions: ReadonlyArray<GoatBotLocalSubmission>;
  readonly committedSends: ReadonlyMap<string, string> | undefined;
  readonly scrollRef: RefObject<HTMLDivElement | null>;
  readonly listRef: RefObject<HTMLOListElement | null>;
  readonly followingRef: RefObject<boolean>;
  readonly lastScrollTopRef: RefObject<number>;
  readonly onExposure?: ((rows: ReadonlyArray<GoatBotRow>) => void) | undefined;
}) {
  const [membership, setMembership] = useState(() => ({
    rows,
    version: 0,
    ids: new Set(rows.map((row) => row.id)),
  }));
  if (
    rows.length !== membership.rows.length ||
    rows.some((row, i) => row.id !== membership.rows[i]?.id)
  )
    setMembership({
      rows,
      version: membership.version + 1,
      ids: new Set(rows.map((row) => row.id)),
    });
  // These sets live in this keyed timeline and hold its row IDs plus this sitting's sends.
  const initialized = useRef(baselineIds === undefined);
  // Created once per mount; a useRef argument would be rebuilt on every streamed update.
  const [seen] = useState(
    () => new Set<string>(baselineIds === undefined ? rows.map((row) => row.id) : []),
  );
  const [eligibleSources] = useState(() => new Set<string>());
  // sentHere tracks displayed send motion; submitted also tracks folded sends without a user row.
  const [submitted] = useState(() => new Set(submissions.map((send) => send.key)));
  const [pending] = useState(() => new Map<string, GoatBotLocalSubmission>());
  const anchor = useRef<string | null>(null);
  const jumpPadding = useRef<string | null>(null);
  const [cueIds, setCueIds] = useState<ReadonlyArray<string>>([]);
  const [following, setFollowingState] = useState(true);
  const setFollowing = (value: boolean) => {
    if (followingRef.current === value) return;
    followingRef.current = value;
    setFollowingState(value);
  };
  const cueRef = useRef<ReadonlyArray<string>>([]);
  const setCue = (next: ReadonlyArray<string>) => {
    if (
      next.length === cueRef.current.length &&
      next.every((id, index) => cueRef.current[index] === id)
    )
      return;
    cueRef.current = next;
    setCueIds(next);
  };
  const rowElement = (id: string) =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-follow-row]") ?? []).find(
      (element) => element.dataset.followRow === id,
    );
  const alignAnchor = () => {
    const scroll = scrollRef.current;
    const row = anchor.current === null ? undefined : rowElement(anchor.current);
    if (!scroll || !row) return false;
    scroll.scrollTop += row.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    lastScrollTopRef.current = scroll.scrollTop;
    return true;
  };
  const clear = () => {
    for (const row of rows) seen.add(row.id);
    setCue([]);
  };
  const clearJumpPadding = () => {
    if (jumpPadding.current !== null && listRef.current) {
      listRef.current.style.paddingBottom = jumpPadding.current;
      jumpPadding.current = null;
    }
  };
  const reachedBottom = () => {
    anchor.current = null;
    clearJumpPadding();
    clear();
  };
  const readerMoved = () => {
    anchor.current = null;
    clearJumpPadding();
  };
  const lastScan = useRef<ReadonlyArray<unknown> | null>(null);
  // oxlint-disable-next-line goat/react-effect-budget -- Reconcile projected arrivals and local sends with the transcript after layout.
  useLayoutEffect(() => {
    // A streamed token changes text only; the scan runs when membership or the inputs change.
    const inputs = [membership.version, submissions, baselineIds, sourceIds, committedSends];
    if (lastScan.current?.every((value, index) => value === inputs[index])) return;
    lastScan.current = inputs;
    const scroll = scrollRef.current;
    if (scroll !== null && followingRef.current) {
      scroll.scrollTop = scroll.scrollHeight;
      lastScrollTopRef.current = scroll.scrollTop;
    }
    if (!initialized.current && baselineIds !== null && baselineIds !== undefined) {
      seen.clear();
      for (const id of baselineIds) seen.add(id);
      initialized.current = true;
    }
    for (const send of submissions) {
      if (submitted.has(send.key)) continue;
      submitted.add(send.key);
      pending.set(send.key, send);
    }
    for (const [key] of pending) {
      const sent = rows.find(
        (row) =>
          row.kind === "user" && (row.sendKey === key || row.id === committedSends?.get(key)),
      );
      const question = rows.find(
        (row) =>
          row.kind === "bot" &&
          (row.answerInputRowId === `pending:${key}` ||
            (row.answerInputRowId !== undefined &&
              row.answerInputRowId === committedSends?.get(key))),
      );
      if (!sent && !question) continue;
      pending.delete(key);
      clearJumpPadding();
      if (question && !sent) {
        setCue([]);
        setFollowing(false);
        anchor.current = question.id;
        alignAnchor();
      } else {
        clear();
        anchor.current = null;
        setFollowing(true);
        const scroll = scrollRef.current;
        if (scroll) {
          scroll.scrollTop = scroll.scrollHeight;
          lastScrollTopRef.current = scroll.scrollTop;
        }
      }
    }
    onExposure?.(rows);
    if (!initialized.current || baselineIds === null) return;
    if (baselineIds !== undefined && sourceIds !== undefined) {
      for (const id of sourceIds) if (!baselineIds.has(id)) eligibleSources.add(id);
    }
    const next = cueRef.current.filter((id) => membership.ids.has(id));
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      if (row.kind !== "bot" && row.kind !== "task") {
        seen.add(row.id);
        continue;
      }
      const eligible = baselineIds === undefined || eligibleSources.has(row.id);
      if (eligible && !followingRef.current) next.push(row.id);
      // A baseline source item can first become visible after filtering; it is never new.
      if (eligible || baselineIds?.has(row.id)) seen.add(row.id);
    }
    if (followingRef.current) clear();
    else setCue(next);
  });
  const jump = () => {
    const scroll = scrollRef.current;
    const first = cueRef.current.map(rowElement).find((row) => row !== undefined);
    if (!scroll) return;
    if (!first) {
      scroll.focus({ preventScroll: true });
      clear();
      return;
    }
    const target =
      scroll.scrollTop + first.getBoundingClientRect().top - scroll.getBoundingClientRect().top;
    const extra = Math.max(0, target - (scroll.scrollHeight - scroll.clientHeight));
    const list = listRef.current;
    if (list && extra > 0) {
      if (jumpPadding.current === null) jumpPadding.current = list.style.paddingBottom;
      list.style.paddingBottom = `${parseFloat(getComputedStyle(list).paddingBottom) + extra}px`;
    }
    scroll.scrollTop = target;
    lastScrollTopRef.current = scroll.scrollTop;
    first.focus({ preventScroll: true });
    clear();
  };
  const visibleCueIds = cueIds.filter((id) => membership.ids.has(id));
  return {
    cueIds: visibleCueIds,
    following,
    setFollowing,
    jump,
    reachedBottom,
    readerMoved,
    alignAnchor,
  };
}
