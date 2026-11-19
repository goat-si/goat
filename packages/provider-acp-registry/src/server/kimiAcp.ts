import type { OrchestrationV2ProviderFailure } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as EffectAcpSchema from "effect-acp/compat";

const NATIVE_SESSION_ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const READ_CHUNK_BYTES = 65_536;
const MAX_OUTCOME_BYTES = 8 * 1024 * 1024;
const MAX_WORKSPACES = 1_024;
const MAX_SESSION_CURSORS = 128;
const MAX_SEEN_TURNS = 64;

const KimiTurnPrompt = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("turn.prompt"),
    agentId: Schema.Literal("main"),
    turnId: Schema.Number,
  }),
);
const decodeTurnPrompt = Schema.decodeUnknownOption(KimiTurnPrompt);

const KimiTurnEnded = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.Literal("turn.ended"),
    agentId: Schema.Literal("main"),
    turnId: Schema.Number,
    reason: Schema.String,
    error: Schema.optional(
      Schema.Struct({
        code: Schema.optional(Schema.String),
        message: Schema.optional(Schema.String),
        retryable: Schema.optional(Schema.Boolean),
      }),
    ),
  }),
);
const decodeTurnEnded = Schema.decodeUnknownOption(KimiTurnEnded);
type KimiTurnEnded = typeof KimiTurnEnded.Type;
class KimiTurnNotEnded extends Schema.TaggedError<KimiTurnNotEnded>()("KimiTurnNotEnded", {}) {}
class KimiLogReset extends Schema.TaggedError<KimiLogReset>()("KimiLogReset", {}) {}
class KimiLogLimit extends Schema.TaggedError<KimiLogLimit>()("KimiLogLimit", {}) {}
const noOutcome = (_result: EffectAcpSchema.PromptResponse) =>
  // @effect-diagnostics-next-line effectSucceedWithVoid:off - The outcome contract requires undefined, not void.
  Effect.succeed<OrchestrationV2ProviderFailure | undefined>(undefined);

function turnFailure(ended: KimiTurnEnded): OrchestrationV2ProviderFailure | undefined {
  if (ended.reason !== "failed") return undefined;
  const code = ended.error?.code;
  return makeProviderFailure({
    message: ended.error?.message ?? "Kimi stopped this turn because of an error.",
    code: code ?? null,
    class:
      code === "provider.rate_limit"
        ? "usage_limit"
        : code === "provider.connection_error"
          ? "transport_error"
          : "provider_error",
    retryable: ended.error?.retryable ?? null,
  });
}

export function kimiRecordedEnvironment(
  recorded: NodeJS.ProcessEnv | undefined,
  runtime: NodeJS.ProcessEnv | undefined,
  launch: unknown,
): NodeJS.ProcessEnv | undefined {
  if (
    recorded === undefined ||
    runtime === undefined ||
    launch === null ||
    typeof launch !== "object" ||
    !("spawn" in launch)
  )
    return undefined;
  const spawn = launch.spawn;
  if (
    spawn === null ||
    typeof spawn !== "object" ||
    !("env" in spawn) ||
    spawn.env === null ||
    typeof spawn.env !== "object" ||
    Array.isArray(spawn.env)
  )
    return undefined;
  const base = spawn.env as Record<string, unknown>;
  const value = (overlay: NodeJS.ProcessEnv, key: "HOME" | "KIMI_CODE_HOME") =>
    Object.hasOwn(overlay, key) ? overlay[key] : base[key];
  const home = value(recorded, "HOME");
  const kimiHome = value(recorded, "KIMI_CODE_HOME");
  if (
    (home !== undefined && typeof home !== "string") ||
    (kimiHome !== undefined && typeof kimiHome !== "string") ||
    home !== value(runtime, "HOME") ||
    kimiHome !== value(runtime, "KIMI_CODE_HOME")
  )
    return undefined;
  return { HOME: home, KIMI_CODE_HOME: kimiHome };
}

export const makeKimiPromptOutcomeWatch = Effect.fn("KimiTurnOutcome.make")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const sessions = new Map<string, Set<number>>();
  return Effect.fn("KimiTurnOutcome.watch")(function* (
    sessionId: string,
    environment: NodeJS.ProcessEnv | undefined,
  ) {
    if (environment === undefined || !NATIVE_SESSION_ID.test(sessionId)) return noOutcome;
    const home =
      environment.KIMI_CODE_HOME?.trim() ||
      (environment.HOME ? path.join(environment.HOME, ".kimi-code") : "");
    if (!home || !path.isAbsolute(home)) return noOutcome;
    const canonicalHome = yield* fileSystem.realPath(home).pipe(Effect.option);
    if (Option.isNone(canonicalHome)) return noOutcome;
    const sessionKey = `${canonicalHome.value}\0${sessionId}`;
    const seen = sessions.get(sessionKey) ?? new Set<number>();
    sessions.delete(sessionKey);
    sessions.set(sessionKey, seen);
    const oldestSession = sessions.keys().next().value;
    if (sessions.size > MAX_SESSION_CURSORS && oldestSession !== undefined)
      sessions.delete(oldestSession);
    const remember = (turnId: number) => {
      seen.delete(turnId);
      seen.add(turnId);
      const oldestTurn = seen.values().next().value;
      if (seen.size > MAX_SEEN_TURNS && oldestTurn !== undefined) seen.delete(oldestTurn);
    };
    const requestedSessions = path.join(canonicalHome.value, "sessions");
    const samePath = (a: string, b: string) =>
      path.sep === "\\" ? a.toLowerCase() === b.toLowerCase() : a === b;
    const findWire = Effect.gen(function* () {
      if (!(yield* fileSystem.exists(requestedSessions))) return Option.none<string>();
      const sessionsDirectory = yield* fileSystem.realPath(requestedSessions);
      const relativeSessions = path.relative(canonicalHome.value, sessionsDirectory);
      if (
        relativeSessions === ".." ||
        relativeSessions.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativeSessions)
      )
        return yield* new KimiLogReset();
      const workspaces = yield* fileSystem.readDirectory(sessionsDirectory);
      if (workspaces.length > MAX_WORKSPACES) return yield* new KimiLogLimit();
      const paths = yield* Effect.forEach(
        workspaces.filter(
          (workspace) =>
            workspace !== "." && workspace !== ".." && path.basename(workspace) === workspace,
        ),
        (workspace) =>
          Effect.gen(function* () {
            const candidate = path.join(
              sessionsDirectory,
              workspace,
              sessionId,
              "agents",
              "main",
              "wire.jsonl",
            );
            if (!(yield* fileSystem.exists(candidate))) return undefined;
            const resolved = yield* fileSystem.realPath(candidate);
            if (!samePath(path.normalize(resolved), path.normalize(candidate)))
              return yield* new KimiLogReset();
            return resolved;
          }),
        { concurrency: 8 },
      );
      const found = paths.filter((candidate): candidate is string => candidate !== undefined);
      if (found.length > 1) return yield* new KimiLogReset();
      const only = found[0];
      return only === undefined ? Option.none<string>() : Option.some(only);
    }).pipe(
      Effect.asSome,
      Effect.orElseSucceed(() => Option.none()),
    );
    const firstLookup = yield* findWire;
    if (Option.isNone(firstLookup)) return noOutcome;
    const before = firstLookup.value;
    const previous = Option.isSome(before)
      ? yield* fileSystem.stat(before.value).pipe(Effect.option)
      : Option.none();
    if (Option.isSome(before) && (Option.isNone(previous) || Option.isNone(previous.value.ino)))
      return noOutcome;
    const startOffset = Option.isSome(previous) ? previous.value.size : 0n;
    const anchorSize = Number(startOffset < 64n ? startOffset : 64n);
    const anchor =
      anchorSize === 0 || Option.isNone(before)
        ? Option.some(new Uint8Array())
        : yield* Effect.scoped(
            Effect.gen(function* () {
              const file = yield* fileSystem.open(before.value, { flag: "r" });
              const info = yield* file.stat;
              if (
                Option.isNone(previous) ||
                info.dev !== previous.value.dev ||
                Option.isNone(info.ino) ||
                info.ino.value !== Option.getOrUndefined(previous.value.ino) ||
                info.size !== startOffset
              )
                return yield* new KimiLogReset();
              const bytes = yield* file.readAlloc(anchorSize, {
                position: startOffset - BigInt(anchorSize),
              });
              if (Option.isNone(bytes) || bytes.value.length !== anchorSize)
                return yield* new KimiLogReset();
              return bytes.value;
            }),
          ).pipe(Effect.option);
    if (Option.isNone(anchor)) return noOutcome;

    return Effect.fn("KimiTurnOutcome.check")(function* (result: EffectAcpSchema.PromptResponse) {
      if (result.stopReason !== "end_turn") return undefined;
      const later = Option.isSome(before) ? Option.some(before) : yield* findWire;
      if (Option.isNone(later) || Option.isNone(later.value)) return undefined;
      const wire = later.value.value;
      let offset = startOffset;
      let discardOldPartial =
        anchor.value.length > 0 && anchor.value[anchor.value.length - 1] !== 0x0a;
      let identity = previous;
      let promptTurnId: number | undefined;
      let replayedTurnId: number | undefined;
      const readAppended = Effect.scoped(
        Effect.gen(function* () {
          const file = yield* fileSystem.open(wire, { flag: "r" });
          const info = yield* file.stat;
          if (Option.isNone(info.ino)) return yield* new KimiLogReset();
          if (
            Option.isSome(identity) &&
            (info.dev !== identity.value.dev ||
              info.ino.value !== Option.getOrUndefined(identity.value.ino) ||
              info.size < offset)
          )
            return yield* new KimiLogReset();
          if (Option.isNone(identity)) identity = Option.some(info);
          if (anchorSize > 0) {
            const currentAnchor = yield* file.readAlloc(anchorSize, {
              position: startOffset - BigInt(anchorSize),
            });
            if (
              Option.isNone(currentAnchor) ||
              !Buffer.from(currentAnchor.value).equals(Buffer.from(anchor.value))
            )
              return yield* new KimiLogReset();
          }
          const chunks: Uint8Array[] = [];
          let position = offset;
          while (position - startOffset < BigInt(MAX_OUTCOME_BYTES)) {
            const remaining = Number(BigInt(MAX_OUTCOME_BYTES) - (position - startOffset));
            const chunk = yield* file.readAlloc(Math.min(READ_CHUNK_BYTES, remaining), {
              position,
            });
            if (Option.isNone(chunk) || chunk.value.length === 0) break;
            chunks.push(chunk.value);
            position += BigInt(chunk.value.length);
          }
          const bytes = Buffer.concat(chunks);
          const complete = bytes.lastIndexOf(0x0a) + 1;
          offset += BigInt(complete);
          let fresh = bytes.subarray(0, complete);
          if (discardOldPartial && complete > 0) {
            fresh = fresh.subarray(fresh.indexOf(0x0a) + 1);
            discardOldPartial = false;
          }
          for (const line of fresh.toString("utf8").split("\n")) {
            if (line.includes('"turn.prompt"')) {
              const prompt = decodeTurnPrompt(line);
              if (Option.isSome(prompt) && Number.isSafeInteger(prompt.value.turnId)) {
                if (seen.has(prompt.value.turnId)) {
                  replayedTurnId = prompt.value.turnId;
                  continue;
                }
                if (promptTurnId !== undefined && promptTurnId !== prompt.value.turnId)
                  return yield* new KimiLogReset();
                promptTurnId = prompt.value.turnId;
                remember(prompt.value.turnId);
              }
            } else if (line.includes('"turn.ended"')) {
              const ended = decodeTurnEnded(line);
              if (Option.isSome(ended) && Number.isSafeInteger(ended.value.turnId)) {
                if (ended.value.turnId === replayedTurnId) {
                  replayedTurnId = undefined;
                  continue;
                }
                remember(ended.value.turnId);
                if (ended.value.turnId === promptTurnId) return ended.value;
              }
            }
          }
          if (position - startOffset >= BigInt(MAX_OUTCOME_BYTES)) return yield* new KimiLogLimit();
          return yield* new KimiTurnNotEnded();
        }),
      );
      return yield* readAppended.pipe(
        Effect.retry({
          times: 40,
          schedule: Schedule.spaced("50 millis"),
          while: (error) => error._tag === "KimiTurnNotEnded",
        }),
        Effect.map(turnFailure),
        Effect.catch((error) => {
          if (error._tag === "KimiLogLimit")
            return Effect.succeed(
              makeProviderFailure({
                message: "Kimi's turn outcome log exceeded the scan limit.",
                class: "provider_error",
              }),
            );
          return Effect.logWarning(
            "Kimi's session log has no attributable outcome for this turn.",
          ).pipe(Effect.as(undefined));
        }),
      );
    });
  });
});
