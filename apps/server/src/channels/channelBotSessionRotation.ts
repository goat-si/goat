/** When a GOAT Bot session must be replaced before its next request, beyond its cache and context. */
import type { OrchestrationV2ProviderTurnTokenUsage, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { BotIdentity } from "./ChannelBotProfiles.ts";
import {
  identityIsCurrent,
  identitySection,
  notesAreCurrent,
  sessionRotationDue,
} from "./channelBotSessionBrief.ts";
import { readRecords } from "./channelBotSessionRecords.ts";
import { isThreadMissing } from "./channelWorkerObservation.ts";

export const PROFILE_UNREADABLE =
  "GOAT Bot could not read its name and purpose, so this message was not run. Send it again once GOAT Bot's profile loads in Settings.";

/**
 * A session's records, or "unknown" when they could not be read: a missing thread runs nothing,
 * but an unreadable one may still be working, so it is never retired on a guess.
 */
export const readSessionRecords = (
  threads: ThreadManagement.ThreadManagementService["Service"],
  threadId: ThreadId | undefined,
) =>
  threadId === undefined
    ? Effect.succeed(Option.none<Effect.Success<ReturnType<typeof readRecords>>>())
    : readRecords(threads, threadId).pipe(
        Effect.asSome,
        Effect.catch((cause) =>
          Effect.succeed(isThreadMissing(cause) ? Option.none() : ("unknown" as const)),
        ),
      );

/** The token usage of a session's newest provider turn, which decides cache and context rotation. */
export const latestTurnUsage = (
  records: Option.Option<Effect.Success<ReturnType<typeof readRecords>>>,
) =>
  Option.isNone(records)
    ? undefined
    : records.value.providerTurns
        .flatMap((turn) => (turn.tokenUsage === undefined ? [] : [turn.tokenUsage]))
        .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0];

export interface SessionCurrent {
  readonly identity: BotIdentity;
  /** The standing notes a new prefix would carry now; undefined when they could not be read. */
  readonly notes: string | undefined;
}

/**
 * The rotation reason for an active session: its cache or context first, then a changed profile,
 * then changed notes. A failed notes read never rotates; the next good read decides.
 */
export const sessionRotationReason = (
  usage: OrchestrationV2ProviderTurnTokenUsage | undefined,
  nowMs: number,
  contextText: string | null,
  current: SessionCurrent,
) =>
  sessionRotationDue(usage, nowMs) ??
  // A row without its prefix predates frozen prefixes and carries no identity.
  ((
    contextText === null
      ? identitySection(current.identity) === ""
      : identityIsCurrent(contextText, current.identity)
  )
    ? undefined
    : ("profile" as const)) ??
  (current.notes === undefined ||
  (contextText !== null && notesAreCurrent(contextText, current.notes))
    ? undefined
    : ("notes" as const));

/** A new session's prefix: the identity, read in the same serve that judged the old one, then the frozen parts. */
export const withIdentity = (identity: BotIdentity, prefix: string) =>
  identitySection(identity) + prefix;
