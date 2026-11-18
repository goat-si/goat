import { MobileMemoryMoveControl } from "./MemoryMoveControl";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  MemoryForgetInput,
  MemoryId,
  MemoryItem,
  MemorySpaceId,
  ScopedThreadRef,
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
import { Menu } from "../../components/ui/Menu";
import { Pressable, View } from "react-native";
import { AppText } from "../../components/ui/AppText";
import { presentMemoryItem } from "@goat/client-runtime/memory-presentation";
import { useThreadShells } from "../../state/entities";
import { memoryEnvironment as memory } from "../../state/memory";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { Action, Copy, MemoryConfirmation, operationId } from "./memoryScreenParts";
import { useMemoryLifetime } from "./MemoryGenerationSettings";

export function MobileMemoryOriginPicker({
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
  const items = [
    { id: "all", title: "All conversations" },
    ...(linked ? [{ id: fromLink.threadId, title: "This conversation" }] : []),
    ...conversations.map((thread) => ({
      id: thread.id,
      title: thread.id === fromLink?.threadId ? "This conversation" : thread.title,
    })),
  ];
  const title = items.find((item) => item.id === origin?.threadId)?.title ?? "All conversations";
  return (
    <Menu
      actions={items}
      onPressAction={({ nativeEvent }) => {
        const thread = conversations.find((conversation) => conversation.id === nativeEvent.event);
        onChange(
          thread
            ? { environmentId, threadId: thread.id }
            : fromLink && fromLink.threadId === nativeEvent.event
              ? fromLink
              : undefined,
        );
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Saved from conversation · ${title}`}
      >
        <Copy>{`Saved from conversation · ${title}`}</Copy>
      </Pressable>
    </Menu>
  );
}

type BatchState = {
  key: string;
  selecting: boolean;
  selected: ReadonlyMap<MemoryId, { forget: MemoryForgetInput; move: MemoryMoveCandidate | null }>;
  confirmation: boolean;
  busy: boolean;
  results: readonly MemoryBatchForgetResult[];
};

const emptyBatch = (key: string): BatchState => ({
  key,
  selecting: false,
  selected: new Map(),
  confirmation: false,
  busy: false,
  results: [],
});

export function useMobileMemoryBatch(
  environmentId: EnvironmentId,
  enabled: boolean,
  canMove: boolean,
  memorySpaceId: MemorySpaceId,
  filterKey: string,
  refresh: () => void,
  items: readonly MemoryItem[],
  readItems: () => readonly MemoryItem[],
) {
  const permitted = useAtomValue(memory.forget.permissionAtom(environmentId));
  const allowed = enabled && permitted;
  const live = useMemoryLifetime(environmentId);
  const forget = useAtomCommand(memory.forget, { reportFailure: false });
  const key = `${filterKey}:${allowed}`;
  const [previous, set] = useState(() => emptyBatch(key));
  const state = previous.key === key ? previous : emptyBatch(key);
  if (previous.key !== key) set(state);
  const patch = (update: Partial<BatchState>) =>
    set((current) => (current.key === key ? { ...current, ...update } : current));
  function toggle(item: MemoryItem) {
    const selected = new Map(state.selected);
    if (!selected.delete(item.memoryId)) {
      if (selected.size >= MEMORY_FORGET_SELECTION_LIMIT) return;
      const request = memoryForgetRequest(item, operationId());
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
    if (!live()) return;
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
  return {
    selecting: allowed && state.selecting,
    row: (item: MemoryItem) =>
      item.status !== "forgotten" && !item.localAvailability.reasons.includes("forget_pending") ? (
        <SettingsSwitchRow
          label={`Select memory ${item.memoryId.slice(-8)}`}
          disabled={state.busy}
          value={state.selected.has(item.memoryId)}
          onValueChange={() => toggle(item)}
        />
      ) : (
        <Copy>Forgotten memory</Copy>
      ),
    controls: !allowed ? null : (
      <>
        <Action
          label={state.selecting ? "Done selecting" : "Select memories"}
          disabled={state.busy}
          onPress={() => (state.selecting ? set(emptyBatch(key)) : patch({ selecting: true }))}
        />
        {state.selecting && canMove ? (
          <MobileMemoryMoveControl
            environmentId={environmentId}
            memorySpaceId={memorySpaceId}
            candidates={moves}
            admitted={admitted}
            isCurrent={(candidate) => memoryMoveCandidateCurrent(candidate, readItems())}
            onMoved={(allMoved) => {
              if (allMoved) set(emptyBatch(key));
              refresh();
            }}
          />
        ) : null}
        {state.selecting ? (
          <Action
            label={`Forget ${state.selected.size}`}
            tone="danger"
            disabled={!state.selected.size || state.busy}
            onPress={() => patch({ confirmation: true })}
          />
        ) : null}
        {state.results.length ? (
          <SettingsSection title="Forget results">
            {state.results.map(({ request, status, reason }) => (
              <Copy key={request.memoryId}>
                Memory {request.memoryId.slice(-8)} · {status}
                {reason ? ` · ${reason}` : ""}
              </Copy>
            ))}
          </SettingsSection>
        ) : null}
        {state.confirmation ? (
          <MemoryConfirmation
            title={`Forget ${state.selected.size} memories?`}
            message="Forgotten memories will also be removed from other devices when they sync."
            label="Confirm forget"
            onConfirm={() => void submit()}
            onClose={() => patch({ confirmation: false })}
          />
        ) : null}
      </>
    ),
  };
}

export function MobileMemorySuggestions({
  environmentId,
  memorySpaceId,
  onSaved,
}: {
  environmentId: EnvironmentId;
  memorySpaceId: MemorySpaceId;
  onSaved: () => void;
}) {
  const registry = useContext(RegistryContext);
  const atom = memory.suggestions({ environmentId, input: { memorySpaceId } });
  const list = useAtomValue(atom);
  const allowed = useAtomValue(memory.acceptSuggestion.permissionAtom(environmentId));
  const canDismiss = useAtomValue(memory.dismissSuggestion.permissionAtom(environmentId));
  const accept = useAtomCommand(memory.acceptSuggestion, { reportFailure: false });
  const dismiss = useAtomCommand(memory.dismissSuggestion, { reportFailure: false });
  const live = useMemoryLifetime(environmentId);
  const [busy, setBusy] = useState<MemoryId | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const suggestions = list._tag === "Success" ? Option.getOrNull(list.value) : null;
  async function act(suggestionId: MemoryId, action: "accept" | "dismiss") {
    if (busy) return;
    setBusy(suggestionId);
    setNotice(null);
    const target = { environmentId, input: { memorySpaceId, suggestionId } };
    if (action === "accept") {
      const result = await accept(target);
      if (!live()) return;
      if (result._tag !== "Success") setNotice("Could not accept this suggestion.");
      else if (result.value.status === "refused")
        setNotice(result.value.reason.replaceAll("_", " "));
      else {
        if (result.value.status === "accepted") setNotice("Memory saved");
        onSaved();
      }
    } else {
      const result = await dismiss(target);
      if (!live()) return;
      if (result._tag !== "Success") setNotice("Could not dismiss this suggestion.");
    }
    setBusy(null);
    registry.refresh(atom);
  }
  return (
    <SettingsSection title="Suggestions">
      {notice ? <Copy>{notice}</Copy> : null}
      {list._tag === "Failure" ? <Copy>Could not load suggestions</Copy> : null}
      {!suggestions?.length ? (
        <>
          {suggestions ? <Copy>No pending suggestions</Copy> : null}
          <Action label="Show suggestions" onPress={() => registry.refresh(atom)} />
        </>
      ) : null}
      {suggestions?.map((suggestion) => (
        <View key={suggestion.suggestionId}>
          <Copy>{suggestion.text}</Copy>
          <Copy>
            {suggestion.state === "accepting"
              ? "Waiting for the memory hub"
              : suggestion.reason.replaceAll("_", " ")}
          </Copy>
          <Action
            label="Accept"
            disabled={!allowed || busy !== null || suggestion.state === "accepting"}
            onPress={() => void act(suggestion.suggestionId, "accept")}
          />
          <Action
            label="Dismiss"
            disabled={!canDismiss || busy !== null || suggestion.state === "accepting"}
            onPress={() => void act(suggestion.suggestionId, "dismiss")}
          />
        </View>
      ))}
    </SettingsSection>
  );
}

export function MemoryProvenanceBadge({ item }: { item: MemoryItem }) {
  const text = presentMemoryItem(item).provenanceLabel;
  return text ? (
    <AppText className="self-start rounded-md border border-border px-2 py-1 text-xs text-foreground-muted">
      {text}
    </AppText>
  ) : null;
}
