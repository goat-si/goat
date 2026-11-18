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
  const conversations = useThreadShells().filter(
    (thread) => thread.environmentId === environmentId,
  );
  const linked = fromLink && !conversations.some((thread) => thread.id === fromLink.threadId);
  return (
    <SettingsRow
      title="Saved from conversation"
      control={
        <Select
          value={origin?.threadId ?? ""}
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
          <SelectTrigger aria-label="Saved from conversation">
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="">All conversations</SelectItem>
            {linked ? <SelectItem value={fromLink.threadId}>This conversation</SelectItem> : null}
            {conversations.map((thread) => (
              <SelectItem key={thread.id} value={thread.id}>
                {thread.id === fromLink?.threadId ? "This conversation" : thread.title}
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
) {
  const registry = useContext(RegistryContext);
  const permitted = useAtomValue(memoryEnvironment.forget.permissionAtom(environmentId));
  const allowed = enabled && permitted;
  const forget = useAtomCommand(memoryEnvironment.forget, { reportFailure: false });
  const key = `${filterKey}:${allowed}`;
  const [previous, set] = useState(() => emptyBulk(key));
  const state = previous.key === key ? previous : emptyBulk(key);
  if (previous.key !== key) set(state);
  const patch = (update: Partial<BulkState>) =>
    set((current) => (current.key === key ? { ...current, ...update } : current));
  function toggle(item: MemoryItem) {
    const selected = new Map(state.selected);
    if (!selected.delete(item.memoryId)) {
      if (selected.size >= MEMORY_FORGET_SELECTION_LIMIT) return;
      const request = memoryForgetRequest(item, MemoryOperationId.make(randomUUID()));
      if (!request) return;
      selected.set(item.memoryId, { forget: request, move: memoryMoveCandidate(item) });
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
  return {
    selecting: allowed && state.selecting,
    row: (item: MemoryItem) =>
      state.selecting && item.status !== "forgotten" && presentSelectable(item) ? (
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={state.selected.has(item.memoryId)}
            disabled={state.busy}
            aria-label={
              item.status === "active"
                ? `Select ${item.payload.text.slice(0, 120)}`
                : `Select memory ${item.memoryId}`
            }
            onChange={() => toggle(item)}
          />
          Select
        </label>
      ) : null,
    controls: !allowed ? null : (
      <>
        <SettingsRow
          title="Manage several memories"
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={state.busy}
                onClick={() => (state.selecting ? set(emptyBulk(key)) : patch({ selecting: true }))}
              >
                {state.selecting ? "Done selecting" : "Select memories"}
              </Button>
              {state.selecting && canMove ? (
                <MemoryMoveControl
                  environmentId={environmentId}
                  memorySpaceId={memorySpaceId}
                  candidates={[...state.selected.values()].flatMap(({ move }) =>
                    move ? [move] : [],
                  )}
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
                  Forget {state.selected.size}
                </Button>
              ) : null}
            </div>
          }
        />
        {state.results.length ? (
          <SettingsRow title="Forget results">
            <ul aria-live="polite" className="text-sm">
              {state.results.map(({ request, status, reason }) => (
                <li key={request.memoryId}>
                  Memory {request.memoryId.slice(-8)} · {status}
                  {reason ? ` · ${reason}` : ""}
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
              <AlertDialogTitle>Forget {state.selected.size} memories?</AlertDialogTitle>
              <AlertDialogDescription>
                Forgotten memories will also be removed from other devices when they sync.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
              <Button variant="destructive" onClick={() => void submit()}>
                Confirm forget
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
      if (result._tag !== "Success") setNotice("Could not accept this suggestion.");
      else if (result.value.status === "refused")
        setNotice(result.value.reason.replaceAll("_", " "));
      else {
        if (result.value.status === "accepted") setNotice("Memory saved");
        onSaved();
      }
    } else if ((await dismiss(target))._tag !== "Success")
      setNotice("Could not dismiss this suggestion.");
    setBusy(null);
    list.refresh();
  }
  return (
    <SettingsSection title="Suggestions">
      {notice ? <SettingsRow title={<span role="status">{notice}</span>} /> : null}
      {list.error ? <SettingsRow title="Could not load suggestions" /> : null}
      {!suggestions?.length ? (
        <SettingsRow
          title={suggestions ? "No pending suggestions" : "Review suggestions"}
          control={
            <Button variant="outline" size="sm" onClick={list.refresh}>
              Show suggestions
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
              ? "Waiting for the memory hub"
              : suggestion.reason.replaceAll("_", " ")
          }
          control={
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!allowed || busy !== null || suggestion.state === "accepting"}
                onClick={() => void act(suggestion.suggestionId, "accept")}
              >
                Accept
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!canDismiss || busy !== null || suggestion.state === "accepting"}
                onClick={() => void act(suggestion.suggestionId, "dismiss")}
              >
                Dismiss
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

/** Producer helpers keep raw storage fields and timestamps out of Settings. */
export function MemoryStatusRows({ sync }: { sync: MemorySyncStatus }) {
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
  ].filter(Boolean);
  return (
    <SettingsSection title="Memory status">
      <SettingsRow title="Hub" description={presentMemorySync(sync).label} />
      <SettingsRow
        title="Storage"
        description={[storage.label, storage.searchLabel, ...storage.reasons].join(". ")}
      />
      <SettingsRow title="Coverage" description={processing.coverage.label} />
      <SettingsRow
        title="Processing"
        description={labels.join(". ") || "No pending processing reported"}
      />
    </SettingsSection>
  );
}
