import { msg, useGT, useMessages } from "gt-react";
import { MemoryMoveControl } from "./MemoryMoveControl";
import type { MemorySyncStatus } from "@goat/contracts";
import {
  presentMemorySync,
  presentMemoryStorage,
  presentMemoryProcessing,
} from "@goat/client-runtime/memory-presentation";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  MemoryOperationId,
  type EnvironmentId,
  type MemoryForgetInput,
  type MemoryId,
  type MemoryItem,
  type MemorySpaceId,
  type ScopedThreadRef,
} from "@goat/contracts";
import {
  memoryForgetRequest,
  memoryMoveCandidate,
  memoryMoveCandidateCurrent,
  type MemoryMoveCandidate,
  MEMORY_FORGET_SELECTION_LIMIT,
} from "@goat/client-runtime/memory-browsing";
import {
  forgetMemorySelection,
  type MemoryBatchForgetResult,
} from "@goat/client-runtime/state/memory";
import * as Option from "effect/Option";
import { useContext, useState } from "react";
import { randomUUID } from "../../lib/utils";
import { useThreadShells } from "../../state/entities";
import { memoryEnvironment } from "../../state/memory";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  AlertDialog,
  AlertDialogPopup,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogClose,
} from "../ui/alert-dialog";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const FAILURE_MESSAGES = new Set<string>([
  msg("unavailable"),
  msg("source unavailable"),
  msg("not found"),
  msg("forgotten"),
  msg("revision changed"),
  msg("operation id reused"),
  msg("missing parent"),
  msg("conflict changed"),
  msg("lease expired"),
  msg("fenced"),
  msg("claim busy"),
  msg("invalid output"),
  msg("generation failed"),
  msg("secret detected"),
  msg("bootstrap required"),
  msg("space mismatch"),
  msg("unsupported protocol"),
  msg("invalid cursor"),
  msg("cursor expired"),
  msg("hub disabled"),
  msg("identity mismatch"),
  msg("route unavailable"),
  msg("lease required"),
  msg("attempt expired"),
  msg("unsupported operation"),
  msg("payload too large"),
  msg("generation input too large"),
  msg("storage failed"),
  msg("source invalidated"),
  msg("thread lineage incomplete"),
  msg("capacity exceeded"),
  msg("base compacted"),
  msg("revert expired"),
  msg("scanner pending"),
  msg("forget pending"),
  msg("hub upgrade required"),
  msg("hub unavailable"),
  msg("move receipt missing"),
  msg("Request could not be confirmed"),
]);

function useMemoryFailureLabel() {
  const m = useMessages();
  return (reason: string) => {
    const label = reason.replaceAll("_", " ");
    return FAILURE_MESSAGES.has(label) ? m(label) : reason;
  };
}

export function MemoryOriginPicker({
  environmentId,
  origin,
  fromLink,
  onChange,
}: {
  environmentId: EnvironmentId;
  origin?: ScopedThreadRef;
  fromLink?: ScopedThreadRef;
  onChange: (origin?: ScopedThreadRef) => void;
}) {
  const gt = useGT();
  const conversations = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId,
  );
  const linked = fromLink && !conversations.some((thread) => thread.id === fromLink.threadId);
  return (
    <SettingsRow
      title={gt("Saved from conversation")}
      control={
        <Select
          value={origin?.threadId ?? null}
          onValueChange={(threadId) => {
            const thread = conversations.find((conversation) => conversation.id === threadId);
            onChange(
              thread
                ? { environmentId, threadId: thread.id }
                : fromLink && fromLink.threadId === threadId
                  ? fromLink
                  : undefined,
            );
          }}
        >
          <SelectTrigger aria-label={gt("Saved from conversation")}>
            <SelectValue placeholder={gt("Any conversation")} />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">{gt("Any conversation")}</SelectItem>
            {linked ? (
              <SelectItem value={fromLink.threadId}>{gt("This conversation")}</SelectItem>
            ) : null}
            {conversations.map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {thread.id === fromLink?.threadId ? gt("This conversation") : thread.title}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

type BulkState = {
  key: string;
  selecting: boolean;
  selected: ReadonlyMap<MemoryId, { forget: MemoryForgetInput; move: MemoryMoveCandidate | null }>;
  confirmation: boolean;
  busy: boolean;
  results: readonly MemoryBatchForgetResult[];
};

const emptyBulk = (key: string): BulkState => ({
  key,
  selecting: false,
  selected: new Map(),
  confirmation: false,
  busy: false,
  results: [],
});

export function useWebMemoryBatch(
  environmentId: EnvironmentId,
  enabled: boolean,
  canMove: boolean,
  memorySpaceId: MemorySpaceId,
  filterKey: string,
  refresh: () => void,
  items: readonly MemoryItem[],
  readItems: () => readonly MemoryItem[],
) {
  const gt = useGT();
  const failureLabel = useMemoryFailureLabel();
  const registry = useContext(RegistryContext);
  const permitted = useAtomValue(memoryEnvironment.forget.permissionAtom(environmentId));
  const m = useMessages();
  const resultLabels = {
    Forgotten: msg("Forgotten"),
    "Pending sync": msg("Pending sync"),
    Failed: msg("Failed"),
  };
  const allowed = enabled && permitted;
  const forget = useAtomCommand(memoryEnvironment.forget, { reportFailure: false });
  const key = `${filterKey}:${allowed}`;
  const [previous, set] = useState(() => emptyBulk(key));
  const state = previous.key === key ? previous : emptyBulk(key);
  if (previous.key !== key) set(state);
  const patch = (update: Partial<BulkState>) =>
    set((current) => (current.key === key ? { ...current, ...update } : current));
  function toggle(memoryId: MemoryId, item?: MemoryItem) {
    const selected = new Map(state.selected);
    if (!selected.delete(memoryId)) {
      if (!item || selected.size >= MEMORY_FORGET_SELECTION_LIMIT) return;
      const request = memoryForgetRequest(item, MemoryOperationId.make(randomUUID()));
      if (!request) return;
      selected.set(memoryId, { forget: request, move: memoryMoveCandidate(item) });
    }
    patch({ selected });
  }
  async function submit() {
    if (!allowed || !state.confirmation || state.busy) return;
    patch({ confirmation: false, busy: true });
    const results = await forgetMemorySelection(
      [...state.selected.values()].map((item) => item.forget),
      (input) => forget({ environmentId, input }),
    );
    if (!registry.get(memoryEnvironment.forget.permissionAtom(environmentId))) return;
    patch({
      busy: false,
      results,
      selected: new Map(
        results
          .filter((result) => result.status === "Failed")
          .flatMap(({ request }) => {
            const item = state.selected.get(request.memoryId);
            return item ? [[request.memoryId, item] as const] : [];
          }),
      ),
    });
    refresh();
  }
  const moves = [...state.selected.values()].flatMap(({ move }) => (move ? [move] : []));
  const admitted = new Set(
    moves
      .filter((candidate) => memoryMoveCandidateCurrent(candidate, items))
      .map(({ memoryId }) => memoryId),
  );
  const selecting = allowed && state.selecting;
  function selectionControl(memoryId: MemoryId, item?: MemoryItem) {
    const checked = state.selected.has(memoryId);
    if (!checked && (!item || item.status === "forgotten" || !presentSelectable(item))) return null;
    return (
      <label className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={checked}
          disabled={state.busy}
          aria-label={gt("Select memory {id}", { id: memoryId.slice(-8) })}
          onChange={() => toggle(memoryId, item)}
        />
        {gt("Select")}
      </label>
    );
  }
  const missing = selecting
    ? [...state.selected.keys()].filter((id) => !items.some((item) => item.memoryId === id))
    : [];
  return {
    selecting,
    rowState: state,
    row: (item: MemoryItem) => selectionControl(item.memoryId, item),
    hiddenRows: missing.map((id) => (
      <SettingsRow
        key={id}
        title={gt("Memory {id} · Text hidden", { id: id.slice(-8) })}
        control={selectionControl(id)}
      />
    )),
    controls: !allowed ? null : (
      <>
        <SettingsRow
          title={gt("Manage several memories")}
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={state.busy}
                onClick={() => (state.selecting ? set(emptyBulk(key)) : patch({ selecting: true }))}
              >
                {state.selecting ? gt("Done selecting") : gt("Select memories")}
              </Button>
              {state.selecting && canMove ? (
                <MemoryMoveControl
                  environmentId={environmentId}
                  memorySpaceId={memorySpaceId}
                  candidates={[...state.selected.values()].flatMap(({ move }) =>
                    move ? [move] : [],
                  )}
                  admitted={admitted}
                  isCurrent={(candidate) => memoryMoveCandidateCurrent(candidate, readItems())}
                  onMoved={(allMoved) => {
                    if (allMoved) set(emptyBulk(key));
                    refresh();
                  }}
                />
              ) : null}
              {state.selecting ? (
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={!state.selected.size || state.busy}
                  onClick={() => patch({ confirmation: true })}
                >
                  {gt("Forget {count}", { count: state.selected.size })}
                </Button>
              ) : null}
            </div>
          }
        />
        {state.results.length ? (
          <SettingsRow title={gt("Forget results")}>
            <ul aria-live="polite" className="text-sm">
              {state.results.map(({ request, status, reason }) => (
                <li key={request.memoryId}>
                  {gt("Memory {id} · {status}", {
                    id: request.memoryId.slice(-8),
                    status: m(resultLabels[status]),
                  })}
                  {reason ? ` · ${failureLabel(reason)}` : ""}
                </li>
              ))}
            </ul>
          </SettingsRow>
        ) : null}
        <AlertDialog
          open={state.confirmation}
          onOpenChange={(confirmation) => patch({ confirmation })}
        >
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {gt("Forget {count, plural, one {# memory} other {# memories}}?", {
                  count: state.selected.size,
                })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {gt("Forgotten memories will also be removed from other devices when they sync.")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>
                {gt("Cancel")}
              </AlertDialogClose>
              <Button variant="destructive" onClick={() => void submit()}>
                {gt("Confirm forget")}
              </Button>
            </AlertDialogFooter>
          </AlertDialogPopup>
        </AlertDialog>
      </>
    ),
  };
}

const presentSelectable = (item: MemoryItem) =>
  !item.localAvailability.reasons.includes("forget_pending");

export function WebMemorySuggestions({
  environmentId,
  memorySpaceId,
  onSaved,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  onSaved: () => void;
}) {
  const gt = useGT();
  const failureLabel = useMemoryFailureLabel();
  const input = { memorySpaceId };
  const list = useEnvironmentQuery(memoryEnvironment.suggestions({ environmentId, input }));
  const allowed = useAtomValue(memoryEnvironment.acceptSuggestion.permissionAtom(environmentId));
  const canDismiss = useAtomValue(
    memoryEnvironment.dismissSuggestion.permissionAtom(environmentId),
  );
  const accept = useAtomCommand(memoryEnvironment.acceptSuggestion, { reportFailure: false });
  const dismiss = useAtomCommand(memoryEnvironment.dismissSuggestion, { reportFailure: false });
  const [busy, setBusy] = useState<MemoryId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const suggestions = list.data ? Option.getOrNull(list.data) : null;
  async function act(suggestionId: MemoryId, action: "accept" | "dismiss") {
    if (busy) return;
    setBusy(suggestionId);
    setNotice(null);
    const target = { environmentId, input: { memorySpaceId, suggestionId } };
    if (action === "accept") {
      const result = await accept(target);
      if (result._tag !== "Success") setNotice(gt("Could not accept this suggestion."));
      else if (result.value.status === "refused") setNotice(failureLabel(result.value.reason));
      else {
        if (result.value.status === "accepted") setNotice(gt("Memory saved"));
        onSaved();
      }
    } else if ((await dismiss(target))._tag !== "Success")
      setNotice(gt("Could not dismiss this suggestion."));
    setBusy(null);
    list.refresh();
  }
  return (
    <SettingsSection title={gt("Suggestions")}>
      {notice ? <SettingsRow title={<span role="status">{notice}</span>} /> : null}
      {list.error ? <SettingsRow title={gt("Could not load suggestions")} /> : null}
      {!suggestions?.length ? (
        <SettingsRow
          title={suggestions ? gt("No pending suggestions") : gt("Review suggestions")}
          control={
            <Button variant="outline" size="sm" onClick={list.refresh}>
              {gt("Show suggestions")}
            </Button>
          }
        />
      ) : null}
      {suggestions?.map((suggestion) => (
        <SettingsRow
          key={suggestion.suggestionId}
          title={suggestion.text}
          description={
            suggestion.state === "accepting"
              ? gt("Waiting for the memory hub")
              : failureLabel(suggestion.reason)
          }
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!allowed || busy !== null || suggestion.state === "accepting"}
                onClick={() => void act(suggestion.suggestionId, "accept")}
              >
                {gt("Accept")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canDismiss || busy !== null || suggestion.state === "accepting"}
                onClick={() => void act(suggestion.suggestionId, "dismiss")}
              >
                {gt("Dismiss")}
              </Button>
            </div>
          }
        />
      ))}
    </SettingsSection>
  );
}

interface MemoryListPageIdentity {
  readonly rowIds: ReadonlyArray<MemoryId>;
}

export interface MemoryListLayout {
  readonly page: MemoryListPageIdentity;
  readonly height: number;
  readonly sizes: ReadonlyMap<string, number>;
}

export const EMPTY_MEMORY_LIST: ReadonlyArray<MemoryItem> = [];
const memoryListPageIdentities = new WeakMap<ReadonlyArray<MemoryItem>, MemoryListPageIdentity>();

export function memoryListPageIdentity(items: ReadonlyArray<MemoryItem>): MemoryListPageIdentity {
  const current = memoryListPageIdentities.get(items);
  if (current) return current;
  const page = { rowIds: items.map((item) => item.memoryId) };
  memoryListPageIdentities.set(items, page);
  return page;
}

export function measureMemoryListRow(
  previous: MemoryListLayout | null,
  page: MemoryListPageIdentity,
  itemKey: string,
  size: number,
): MemoryListLayout {
  if (previous?.page === page && previous.sizes.get(itemKey) === size) return previous;
  const sizes = new Map(previous?.page === page ? previous.sizes : []);
  sizes.set(itemKey, size);
  const height = Math.min(
    320,
    Math.ceil(page.rowIds.reduce((total, id) => total + (sizes.get(id) ?? 88), 0)),
  );
  return { page, height, sizes };
}

const MEMORY_STATUS_MESSAGES = new Set<string>([
  msg("Memory sharing off"),
  msg("Receiving initial memories"),
  msg("Hub connected"),
  msg("Hub disconnected"),
  msg("Memory sync error"),
  msg("Connect a memory space"),
  msg("Hub connection not confirmed"),
  msg("Memory search unavailable"),
  msg("Some memories are still being indexed"),
  msg("Memory coverage unknown"),
  msg("Memory search ready"),
  msg("Originals retained for revert"),
  msg("Waiting for active work"),
  msg("Work pending"),
  msg("Checkpoint retained"),
  msg("Memory storage unavailable"),
  msg("Search indexing paused"),
  msg("Memory cleanup needs attention"),
  msg("Reports waiting to be delivered"),
  msg("Memory storage nearly full"),
  msg("Memory storage getting full"),
  msg("Memory storage usage unknown"),
  msg("Memory storage available"),
  msg("Search storage usage unknown"),
  msg("Search indexing available"),
  msg("Checking content"),
  msg("Sensitive content on hold; forgetting is available"),
  msg("Waiting for earlier memories"),
  msg("Memory processing pending"),
  msg("Cleaning up remaining content"),
  msg("Sync progress unknown"),
  msg("Receiving memories"),
  msg("Memories received"),
  msg("Some reports could not be delivered"),
  msg("Some memory changes could not be accepted"),
  msg("Memory storage limit reached"),
]);

/** Producer helpers keep raw storage fields and timestamps out of Settings. */
export function MemoryStatusRows({ sync }: { sync: MemorySyncStatus }) {
  const gt = useGT();
  const localize = useMessages();
  const statusLabel = (source: string) =>
    MEMORY_STATUS_MESSAGES.has(source) ? localize(source) : source;
  const storage = presentMemoryStorage(sync.storage);
  const processing = presentMemoryProcessing(sync.processing, sync.generationHold);
  const labels = [
    processing.pausedLabel,
    processing.checkingLabel,
    processing.heldLabel,
    processing.waitingLabel,
    processing.cleanupLabel,
    processing.receiveLabel,
    processing.reportLabel,
    processing.admissionLabel,
  ].filter((label) => label !== null);
  return (
    <SettingsSection title={gt("Memory status")}>
      <SettingsRow title={gt("Hub")} description={statusLabel(presentMemorySync(sync).label)} />
      <SettingsRow
        title={gt("Storage")}
        description={[storage.label, storage.searchLabel, ...storage.reasons]
          .map(statusLabel)
          .join(". ")}
      />
      <SettingsRow title={gt("Coverage")} description={statusLabel(processing.coverage.label)} />
      <SettingsRow
        title={gt("Processing")}
        description={labels.map(statusLabel).join(". ") || gt("No pending processing reported")}
      />
    </SettingsSection>
  );
}
