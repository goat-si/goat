/** When a GOAT Bot session must be replaced before its next request, beyond its cache and context. */
import type { OrchestrationV2ProviderTurnTokenUsage, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { BotIdentity } from "./ChannelBotProfiles.ts";
import {
  identityIsCurrent,
  identitySection,
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

/** The rotation reason for an active session: its cache or context first, then a changed profile. */
export const sessionRotationReason = (
  usage: OrchestrationV2ProviderTurnTokenUsage | undefined,
  nowMs: number,
  contextText: string | null,
  identity: BotIdentity,
) =>
  sessionRotationDue(usage, nowMs) ??
  // A row without its prefix predates frozen prefixes and carries no identity.
  ((
    contextText === null
      ? identitySection(identity) === ""
      : identityIsCurrent(contextText, identity)
  )
    ? undefined
    : ("profile" as const));

/** A new session's prefix: the identity, read in the same serve that judged the old one, then the frozen parts. */
export const withIdentity = (identity: BotIdentity, prefix: string) =>
  identitySection(identity) + prefix;
