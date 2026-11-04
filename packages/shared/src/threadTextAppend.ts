import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ResolvedThreadStreamItem,
  OrchestrationV2ThreadStreamItem,
} from "@goat/contracts";

/**
 * Live thread subscriptions can send streaming text as appends. The server's encoder and the
 * client's decoder each keep one memory per subscription and update it from the same ordered
 * items, so both memories stay identical and an append always lands on the text it extends.
 */
const TEXT_APPEND_MEMORY = 32;

interface StreamedText {
  readonly key: string;
  readonly text: string;
  readonly keep: boolean;
}

function streamedText(event: OrchestrationV2DomainEvent): StreamedText | null {
  if (event.type === "message.updated") {
    const { id, text, streaming } = event.payload;
    return { key: `message:${id}`, text, keep: streaming };
  }
  if (event.type !== "turn-item.updated") return null;
  const item = event.payload;
  if (item.type === "reasoning") {
    return { key: `item:${item.id}`, text: item.text, keep: item.streaming };
  }
  if (item.type === "assistant_message") {
    return {
      key: `item:${item.id}`,
      text: item.text,
      keep: item.streaming && item.textOmitted !== true,
    };
  }
  return null;
}

function withText(event: OrchestrationV2DomainEvent, text: string): OrchestrationV2DomainEvent {
  if (event.type === "message.updated") return { ...event, payload: { ...event.payload, text } };
  if (
    event.type === "turn-item.updated" &&
    (event.payload.type === "reasoning" || event.payload.type === "assistant_message")
  ) {
    return { ...event, payload: { ...event.payload, text } };
  }
  return event;
}

function makeTextMemory() {
  const texts = new Map<string, string>();
  return {
    get: (key: string) => texts.get(key),
    note: ({ key, text, keep }: StreamedText) => {
      texts.delete(key);
      if (!keep) return;
      texts.set(key, text);
      if (texts.size <= TEXT_APPEND_MEMORY) return;
      const oldest = texts.keys().next();
      if (!oldest.done) texts.delete(oldest.value);
    },
  };
}

/** One per subscription, after every other per-item wire projection. */
export function makeThreadTextAppendEncoder(): (
  item: OrchestrationV2ThreadStreamItem,
) => OrchestrationV2ThreadStreamItem {
  const memory = makeTextMemory();
  return (item) => {
    if (item.kind !== "event") return item;
    const target = streamedText(item.event);
    if (target === null) return item;
    const sent = memory.get(target.key);
    memory.note(target);
    if (sent === undefined || target.text.length <= sent.length || !target.text.startsWith(sent)) {
      return item;
    }
    // Offsets count UTF-16 code units; a split surrogate pair survives JSON and rejoins.
    return {
      kind: "text-append",
      sequence: item.sequence,
      offset: sent.length,
      event: withText(item.event, target.text.slice(sent.length)),
    };
  };
}

/** One per subscription. `null` means the append does not extend the text this side holds. */
export function makeThreadTextAppendDecoder(): (
  item: OrchestrationV2ThreadStreamItem,
) => OrchestrationV2ResolvedThreadStreamItem | null {
  const memory = makeTextMemory();
  return (item) => {
    if (item.kind === "event") {
      const target = streamedText(item.event);
      if (target !== null) memory.note(target);
      return item;
    }
    if (item.kind !== "text-append") return item;
    const target = streamedText(item.event);
    const held = target === null ? undefined : memory.get(target.key);
    if (target === null || held === undefined || held.length !== item.offset) return null;
    const text = held + target.text;
    memory.note({ ...target, text });
    return { kind: "event", sequence: item.sequence, event: withText(item.event, text) };
  };
}
