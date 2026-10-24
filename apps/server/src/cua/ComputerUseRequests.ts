/**
 * A thread asking a person for computer use on this host, of the whole screen or of the apps it
 * names. The request is an approval handoff on the computer_use.grant path whose expiry is the
 * end of the admission; a person allowed to change this environment's settings answers it in a
 * GOAT client. Interactive threads ask for apps; unattended ones need an admission at all.
 *
 * @module ComputerUseRequests
 */
import {
  COMPUTER_USE_GRANT_HANDOFF_PATH,
  type ComputerUseRequestInput,
  type ComputerUseRequestResult,
  cuaAgentBlockMessage,
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
import { computerUseOrigin, projectionOriginReads } from "./ComputerUseOrigin.ts";

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
  // An approval would not help: the desktop will not start the driver until macOS allows it.
  const block = CuaDriver.agentBlock(yield* cua.value.lastFailure);
  if (block !== undefined)
    return {
      kind: "refused",
      reason: "not_granted",
      block,
      message: cuaAgentBlockMessage(block),
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
  const threads = yield* ThreadManagement.ThreadManagementService;
  const origin = yield* computerUseOrigin(
    projectionOriginReads({
      getThreadRecords: (id, fields, filter) => threads.getThreadRecords(id, fields, filter),
      channelOrigin: leases.channelOrigin,
    }),
    { threadId: input.threadId },
  );
  const detection = yield* leases.detection;
  if (origin._tag === "unattended" && (!detection.humanInput || !detection.privateMode))
    return {
      kind: "refused",
      reason: "detection_unsupported",
      message:
        "This host cannot yet tell when a person types a secret or uses the desktop, so work that runs on its own cannot use the screen here. A person can still run computer use from a thread they direct.",
    } satisfies ComputerUseRequestResult;
  const own = yield* leases.active(input.threadId);
  const wanted = input.request.apps;
  // A live admission answers the request only when it already covers what is asked.
  const granted = Option.isSome(own) ? own.value.apps : [];
  const covered =
    Option.isSome(own) &&
    (granted === undefined ||
      (wanted !== undefined &&
        wanted.every((app) => granted.some((name) => name.toLowerCase() === app.toLowerCase()))));
  if (Option.isSome(own) && covered)
    return {
      kind: "available",
      message: `This thread is admitted${own.value.apps === undefined ? "" : ` for ${own.value.apps.join(", ")}`} until ${DateTime.formatIso(own.value.expiresAt)}. The cua-driver tools are attached from your next turn if they are not already.`,
    } satisfies ComputerUseRequestResult;

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
  const title = view.projection.thread.title.trim() || "A thread";
  const what =
    wanted === undefined
      ? "see and control this computer's screen"
      : `control ${wanted.join(", ")}`;
  const handoffs = yield* Handoffs.Handoffs;
  const handoff = yield* handoffs.create({
    kind: "approval",
    title:
      wanted === undefined
        ? `Allow computer use on ${host}?`
        : `Allow ${wanted.join(", ")} on ${host}?`,
    reason: `${title} (turn ${run.ordinal}) asks to ${what} ${span}: ${input.request.purpose}`,
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
        `${title}, turn ${run.ordinal} (run ${run.id}), asks to ${what} on ${host} ${span} (${until}).`,
        `Its stated purpose: ${input.request.purpose}`,
        wanted === undefined
          ? "Approving admits this thread's turns until then; it does not approve each action, and anything the screen shows can be clicked or typed into. You can end it early from this request in the thread, and turning computer use off ends it too."
          : "Approving admits this thread's turns to these apps' windows until then; it does not approve each action, and anything those windows show can be clicked or typed into. You can end it early from this request in the thread, and turning computer use off ends it too.",
      ].join("\n\n"),
    },
    args: {
      purpose: input.request.purpose,
      minutes,
      ...(wanted === undefined ? {} : { apps: wanted }),
    },
    expiresAt,
    ...(wanted === undefined ? {} : { apps: wanted }),
  });
  // A repeated request returns the pending handoff with its original expiry.
  const approvedUntil = DateTime.formatIso(handoff.expiresAt ?? expiresAt);
  return {
    kind: "needs_human",
    handoff,
    // Calling again after approval reads the admission and returns available.
    next: { after: "approval", call: "goat_computer_use_request" },
    message: `A person must approve this in a GOAT app; a reply in a chat channel does not count. If they approve before ${approvedUntil}, your next turn in this thread has the cua-driver tools until then. End this turn now.`,
  } satisfies ComputerUseRequestResult;
});
