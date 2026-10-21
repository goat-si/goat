/**
 * An unattended thread asking a person for computer use on this host. The request is an
 * approval handoff on the computer_use.grant path whose expiry is the end of the admission;
 * a person allowed to change this environment's settings answers it in a GOAT client.
 *
 * @module ComputerUseRequests
 */
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type ComputerUseRequestInput,
  type ComputerUseRequestResult,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as CuaDriver from "./CuaDriver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";

const DEFAULT_MINUTES = 30;

export const requestComputerUse = Effect.fn("ComputerUse.request")(function* (input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly request: ComputerUseRequestInput;
}) {
  const cua = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  if (Option.isNone(cua) || !(yield* cua.value.enabled))
    return {
      kind: "refused",
      reason: "disabled",
      message: "Computer use is off on this host. A person turns it on in Settings.",
    } satisfies ComputerUseRequestResult;
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  const held = yield* leases.holder(input.threadId);
  if (Option.isSome(held))
    return {
      kind: "refused",
      reason: "held",
      holderThreadId: held.value.threadId,
      message: `Thread ${held.value.threadId} holds computer use on this host until ${DateTime.formatIso(held.value.expiresAt)}. Ask again after it ends.`,
    } satisfies ComputerUseRequestResult;
  const own = yield* leases.active(input.threadId);
  if (Option.isSome(own))
    return {
      kind: "available",
      message: `This thread is admitted until ${DateTime.formatIso(own.value.expiresAt)}. The cua-driver tools are attached from your next turn if they are not already.`,
    } satisfies ComputerUseRequestResult;

  const threads = yield* ThreadManagement.ThreadManagementService;
  const view = yield* threads.getThreadSnapshot(input.threadId);
  const run = view.projection.runs.at(-1);
  if (!run || run.rootNodeId === null)
    return {
      kind: "refused",
      reason: "unsupported",
      message: "Ask from a running turn of this thread.",
    } satisfies ComputerUseRequestResult;
  const minutes = input.request.minutes ?? DEFAULT_MINUTES;
  const expiresAt = DateTime.add(yield* DateTime.now, { minutes });
  const until = DateTime.formatIso(expiresAt);
  // Cards show the expiry in the reader's own time; the text gives the span and a UTC clock time.
  const span = `for ${minutes} minutes, until ${until.slice(11, 16)} UTC`;
  const host = yield* HostProcess.Hostname;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const title = view.projection.thread.title.trim() || "An unattended thread";
  const handoffs = yield* Handoffs.Handoffs;
  const handoff = yield* handoffs.create({
    kind: "approval",
    title: `Allow computer use on ${host}?`,
    reason: `${title} (turn ${run.ordinal}) asks to see and control this computer's screen ${span}: ${input.request.purpose}`,
    requestedBy: {
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      path: COMPUTER_USE_GRANT_HANDOFF_PATH,
    },
    target: { environmentId, path: COMPUTER_USE_GRANT_HANDOFF_PATH },
    runId: run.id,
    nodeId: run.rootNodeId,
    human: {
      location: [
        `${title}, turn ${run.ordinal} (run ${run.id}), asks to use the screen of ${host} ${span} (${until}).`,
        `Its stated purpose: ${input.request.purpose}`,
        "Approving admits this thread's turns until then; it does not approve each action, and anything the screen shows can be clicked or typed into. You can end it early from this request in the thread, and turning computer use off ends it too.",
      ].join("\n\n"),
    },
    args: { purpose: input.request.purpose, minutes },
    expiresAt,
  });
  return {
    kind: "needs_human",
    handoff,
    message: `A person must approve this in a GOAT app; a reply in a chat channel does not count. If they approve before ${until}, your next turn in this thread has the cua-driver tools until then. End this turn now.`,
  } satisfies ComputerUseRequestResult;
});
