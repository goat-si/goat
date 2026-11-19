import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as AcpSchema from "effect-acp/compat";

const MAX_WAKE_FRAMES = 128;
const MAX_WAKE_CHARACTERS = 4 * 1024 * 1024;
const encodeWakeFrame = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type WakeFrameKind = "result" | "thought" | "other";

function frameKind(
  notification: AcpSchema.SessionNotification,
  offerEvidence: boolean,
): WakeFrameKind {
  const { sessionUpdate } = notification.update;
  if (offerEvidence || sessionUpdate === "agent_message") return "result";
  return sessionUpdate === "agent_thought_chunk" || sessionUpdate === "agent_thought"
    ? "thought"
    : "other";
}

export function makeAcpWakeBuffer() {
  let frames: Array<{
    notification: AcpSchema.SessionNotification;
    characters: number;
    kind: WakeFrameKind;
  }> = [];
  let totalCharacters = 0;
  const clear = () => {
    frames.length = 0;
    totalCharacters = 0;
  };
  return {
    length: Effect.sync(() => frames.length),
    clear: Effect.sync(clear),
    append: (notification: AcpSchema.SessionNotification, offerEvidence: boolean) =>
      Effect.sync(() => {
        const characters = encodeWakeFrame(notification).length;
        if (characters > MAX_WAKE_CHARACTERS) return false;
        const kind = frameKind(notification, offerEvidence);
        if (
          frames.length >= MAX_WAKE_FRAMES ||
          totalCharacters + characters > MAX_WAKE_CHARACTERS
        ) {
          const evictions = new Set<(typeof frames)[number]>();
          let retainedCharacters = totalCharacters;
          const fits = () =>
            frames.length - evictions.size < MAX_WAKE_FRAMES &&
            retainedCharacters + characters <= MAX_WAKE_CHARACTERS;
          const expendableKinds = kind === "thought" ? ["thought"] : ["thought", "other"];
          for (const expendableKind of expendableKinds) {
            for (const frame of frames) {
              if (fits()) break;
              if (frame.kind !== expendableKind) continue;
              evictions.add(frame);
              retainedCharacters -= frame.characters;
            }
          }
          if (!fits()) return false;
          frames = frames.filter((frame) => !evictions.has(frame));
          totalCharacters = retainedCharacters;
        }
        frames.push({ notification, characters, kind });
        totalCharacters += characters;
        return true;
      }),
    some: (matches: (notification: AcpSchema.SessionNotification) => boolean) =>
      Effect.sync(() => frames.some(({ notification }) => matches(notification))),
    take: (sessionId: string) =>
      Effect.sync(() => {
        const result = frames.flatMap(({ notification }) =>
          notification.sessionId === sessionId ? [notification] : [],
        );
        clear();
        return result;
      }),
  };
}
