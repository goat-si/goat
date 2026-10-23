import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * Reads a cloud session's state from the transcript `claude --print --teleport` writes for its
 * local fork. Claude marks every line it copied from the cloud with `remoteSourced: true`; the
 * teleport's own continuation notice, prompt and reply are local and never count.
 */

const TeleportResult = Schema.Struct({
  session_id: Schema.String,
  total_cost_usd: Schema.optional(Schema.Number),
});
const decodeTeleportResult = Schema.decodeUnknownOption(Schema.fromJsonString(TeleportResult));
const LOCAL_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The local fork's ID and what its read turn cost, from `--output-format json`. */
export function readTeleportResult(stdout: string) {
  const result = decodeTeleportResult(stdout.trim());
  if (Option.isNone(result) || !LOCAL_SESSION_ID.test(result.value.session_id)) return undefined;
  return {
    localSessionId: result.value.session_id,
    costUsd: result.value.total_cost_usd ?? null,
  };
}

const Block = Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) });
const Line = Schema.Struct({
  type: Schema.String,
  remoteSourced: Schema.optional(Schema.Boolean),
  isMeta: Schema.optional(Schema.Boolean),
  isApiErrorMessage: Schema.optional(Schema.Boolean),
  timestamp: Schema.optional(Schema.String),
  message: Schema.optional(
    Schema.Struct({
      content: Schema.optional(Schema.Union([Schema.String, Schema.Array(Block)])),
      stop_reason: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
type Line = typeof Line.Type;
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line));

/**
 * A prompt older than the run's start by more than this cannot be the run's own prompt. The
 * margin absorbs clock skew between this machine and the cloud.
 */
const PROMPT_CLOCK_SKEW_MS = 60_000;

export interface ReplyAnchor {
  /** The text GOAT sent for this run, when it is still known. */
  readonly prompt?: string;
  /** When this run started, in epoch milliseconds. */
  readonly since: number;
  /** A session registered after its prompt was sent: its latest prompt is the run's. */
  readonly latest?: boolean;
}

type SessionReply =
  | { readonly state: "waiting" }
  | { readonly state: "running" }
  | { readonly state: "replied"; readonly text: string }
  | { readonly state: "failed"; readonly error: string };

const blocks = (line: Line) => {
  const content = line.message?.content;
  return typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
};
const textOf = (lines: ReadonlyArray<Line>) =>
  lines
    .flatMap((line) => blocks(line))
    .flatMap((block) => (block.type === "text" && block.text?.trim() ? [block.text.trim()] : []))
    .join("\n\n");
const isPrompt = (line: Line) =>
  line.type === "user" &&
  line.isMeta !== true &&
  blocks(line).some((block) => block.type === "text") &&
  !blocks(line).some((block) => block.type === "tool_result");
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The reply to the run's prompt. A turn is finished only when the last cloud line after that
 * prompt is an assistant line that stopped with end_turn; a tool_use line, a tool result or a
 * stop_sequence snapshot means the session is still working.
 */
export function readSessionReply(transcript: string, anchor: ReplyAnchor): SessionReply {
  const lines = transcript
    .split("\n")
    .flatMap((raw) => (raw.trim() ? Option.toArray(decodeLine(raw)) : []))
    .filter(
      (line) => line.remoteSourced === true && (line.type === "user" || line.type === "assistant"),
    );
  const prompts = lines.flatMap((line, index) => {
    if (!isPrompt(line)) return [];
    const at = line.timestamp === undefined ? Number.NaN : Date.parse(line.timestamp);
    return anchor.latest || Number.isNaN(at) || at >= anchor.since - PROMPT_CLOCK_SKEW_MS
      ? [{ index, text: normalize(textOf([line])) }]
      : [];
  });
  const wanted = anchor.prompt === undefined ? undefined : normalize(anchor.prompt);
  const start = (prompts.findLast((prompt) => prompt.text === wanted) ?? prompts.at(-1))?.index;
  if (start === undefined) return { state: "waiting" };
  const next = lines.findIndex((line, index) => index > start && isPrompt(line));
  const turn = lines.slice(start + 1, next < 0 ? undefined : next);
  const last = turn.at(-1);
  if (last?.type !== "assistant") return { state: "running" };
  if (last.isApiErrorMessage === true)
    return { state: "failed", error: textOf([last]) || "The cloud session reported an error." };
  // A later prompt means the session moved past this turn even without a clean stop.
  if (last.message?.stop_reason !== "end_turn" && next < 0) return { state: "running" };
  let final = turn.length;
  while (final > 0 && turn[final - 1]?.type === "assistant") final -= 1;
  const text = textOf(turn.slice(final)) || textOf(turn);
  return { state: "replied", text: text || "The cloud session finished without a text reply." };
}
