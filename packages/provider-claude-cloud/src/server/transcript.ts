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
  /** The text GOAT sent for this run. When known, only a cloud prompt that matches it counts. */
  readonly prompt?: string;
  /**
   * Texts of the prompts GOAT delivered to this session before this run. Each earlier prompt the
   * run's text matches claims one matching cloud prompt, so a repeated message never adopts an
   * older turn's reply.
   */
  readonly earlierPrompts?: ReadonlyArray<string>;
  /** When this run started, in epoch milliseconds. */
  readonly since: number;
  /** The first run of a session registered after its prompt was sent: its latest prompt is the run's. */
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
/** Short prompts must match exactly; a longer one may arrive wrapped in context Claude adds. */
const matches = (cloud: string, wanted: string) =>
  cloud === wanted || (wanted.length >= 16 && cloud.includes(wanted));

/**
 * The reply to the run's prompt. The prompt is found by its text, or without text by the first
 * prompt stamped after the run started; GOAT never guesses another run's prompt. A known text
 * selects the matching cloud prompt after those earlier deliveries claimed theirs, and that prompt
 * must also be recent. The turn is finished at
 * the first assistant line after it that stopped with end_turn; until then a tool_use line, a
 * tool result or a stop_sequence snapshot means the session is still working. A prompt sent
 * meanwhile is queued into the same turn, so it does not end it.
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
    return [{ index, at, text: normalize(textOf([line])) }];
  });
  const recent = (at: number, margin: number) => Number.isNaN(at) || at >= anchor.since - margin;
  const wanted = anchor.prompt === undefined ? undefined : normalize(anchor.prompt);
  const occurrence = (text: string) => {
    const claimed = (anchor.earlierPrompts ?? []).filter((earlier) =>
      matches(normalize(earlier), text),
    ).length;
    const own = prompts.filter((prompt) => matches(prompt.text, text))[claimed];
    return own && recent(own.at, PROMPT_CLOCK_SKEW_MS) ? own : undefined;
  };
  const start = (
    anchor.latest
      ? prompts.at(-1)
      : wanted !== undefined
        ? occurrence(wanted)
        : // Without its text, only a prompt stamped after the run started can be the run's.
          prompts.find((prompt) => !Number.isNaN(prompt.at) && recent(prompt.at, 0))
  )?.index;
  if (start === undefined) return { state: "waiting" };
  const end = lines.findIndex(
    (line, index) =>
      index > start && line.type === "assistant" && line.message?.stop_reason === "end_turn",
  );
  if (end < 0) {
    const last = lines.at(-1);
    // Claude writes a synthetic error line once its retries are spent; nothing follows it.
    return lines.length - 1 > start && last?.isApiErrorMessage === true
      ? { state: "failed", error: textOf([last]) || "The cloud session reported an error." }
      : { state: "running" };
  }
  let final = end;
  while (final > start + 1 && lines[final - 1]?.type === "assistant") final -= 1;
  const text = textOf(lines.slice(final, end + 1)) || textOf(lines.slice(start + 1, end + 1));
  return { state: "replied", text: text || "The cloud session finished without a text reply." };
}
