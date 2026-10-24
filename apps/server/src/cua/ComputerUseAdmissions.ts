import { COMPUTER_USE_GRANT_HANDOFF_PATH, Handoff } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { ComputerUseLease } from "./ComputerUseLeases.ts";

export const decodeHandoff = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.toCodecJson(Handoff)),
);

/** A completed grant before its expiry. A grant without an expiry is never live. */
export const leaseOf = (handoff: Handoff, now: DateTime.Utc): Option.Option<ComputerUseLease> =>
  handoff.target.path === COMPUTER_USE_GRANT_HANDOFF_PATH &&
  handoff.state === "completed" &&
  handoff.expiresAt !== null &&
  DateTime.toEpochMillis(handoff.expiresAt) > DateTime.toEpochMillis(now)
    ? Option.some({
        threadId: handoff.requestedBy.threadId,
        handoffId: handoff.handoffId,
        expiresAt: handoff.expiresAt,
        ...(handoff.apps === undefined ? {} : { apps: handoff.apps }),
        ...(handoff.computerUseForeground === undefined
          ? {}
          : { computerUseForeground: handoff.computerUseForeground }),
      })
    : Option.none();
