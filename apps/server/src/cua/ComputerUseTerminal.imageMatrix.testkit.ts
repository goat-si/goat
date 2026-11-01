import * as Effect from "effect/Effect";
import type { ComputerUsePrimitiveReply } from "@goat/contracts";
import { driverError, driverFailureNextStep } from "../screenCode/DesktopDriverReplies.ts";
import { admitDriverReplyScreenshots } from "./ComputerUseDriverReply.ts";
import { primitiveReplySink } from "./ComputerUseLeaseProxyOptions.ts";
import {
  replaceWithTerminal,
  terminalReplyState,
  type ComputerUseTerminalReason,
} from "./ComputerUseTerminal.ts";

export const imageCompact = (input: {
  readonly possible: boolean;
  readonly reasons: readonly ComputerUseTerminalReason[];
}) =>
  Effect.gen(function* () {
    let answer: ComputerUsePrimitiveReply | undefined;
    const request = {
      state: "primitive-request" as const,
      requestId: "request",
      registrationId: "registration",
      controlId: "control",
      connectionGeneration: "g",
      runId: "run",
      turnId: "turn",
      callId: 1,
      deadlineMillis: 30000,
      tool: "list_apps",
      args: {},
    };
    const line = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      result: {
        isError: true,
        structuredContent: {
          code: replaceWithTerminal("none", ...input.reasons).reason,
          safety: { possibleCommit: input.possible, retryClass: "never" },
          screenshot_width: 1,
          screenshot_height: 1,
          padding: "x".repeat(1024 * 1024),
        },
        content: [
          {
            type: "image",
            mimeType: "image/png",
            data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
          },
        ],
      },
    });
    yield* primitiveReplySink(request, (reply) =>
      Effect.sync(() => {
        answer = reply;
      }),
    ).answer(admitDriverReplyScreenshots(line), "settled");
    return replaceWithTerminal(terminalReplyState(answer?.result, answer?.status));
  });

export const busyTerminalNextStep = (input: {
  readonly possible: boolean;
  readonly reasons: readonly ComputerUseTerminalReason[];
}) =>
  Effect.sync(() => {
    const reason = replaceWithTerminal("none", ...input.reasons).reason;
    if (reason === undefined) throw new Error("Expected terminal reason");
    const reply: ComputerUsePrimitiveReply = {
      requestId: "request",
      registrationId: "registration",
      controlId: "control",
      connectionGeneration: "g",
      runId: "run",
      turnId: "turn",
      callId: 1,
      status: "settled",
      error: { code: -32000, data: { code: reason, safety: { possibleCommit: input.possible } } },
      result: {
        isError: true,
        structuredContent: {
          code: "desktop_busy",
          effect: "refused",
          safety: { possibleCommit: input.possible },
        },
      },
    };
    const error = driverError(reply);
    if (error === undefined) throw new Error("Expected terminal error");
    const nextStep = driverFailureNextStep(reply, error, input.possible);
    if (nextStep !== error.nextStep)
      throw new Error("Busy refusal replaced the terminal instruction");
    return replaceWithTerminal(error);
  });
