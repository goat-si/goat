import { describeHolder } from "./computerUseGrants.ts";
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
  type Handoff,
  handoffSummary,
  type ProviderInstanceId,
  type ThreadId,
} from "@goat/contracts";
import * as HostProcess from "@goat/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Handoffs from "../handoffs/Handoffs.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import type { ComputerUseAnswer } from "../handoffs/computerUseContinuations.ts";
import * as CuaDriver from "./CuaDriver.ts";
import * as ComputerUseLeases from "./ComputerUseLeases.ts";
import { computerUseOrigin, projectionOriginReads } from "./ComputerUseOrigin.ts";

const DEFAULT_MINUTES = 30;

/**
 * What an approval card says, once: the summary names the thread, turn, apps and span, and the
 * details shown after "Review request" say what approving does. Cards show the expiry in the
 * reader's own time, so neither carries a clock time, and neither names the internal run id.
 */
const grantText = (input: {
  readonly title: string;
  readonly turn: number;
  readonly apps: ReadonlyArray<string> | undefined;
  readonly minutes: number;
  readonly purpose: string;
  readonly foreground: boolean;
}) => ({
  reason: `${input.title} (turn ${input.turn}) asks to ${input.apps === undefined ? "see and control this computer's screen" : `control ${input.apps.join(", ")}`} for ${input.minutes} minutes: ${input.purpose}. ${
    input.foreground
      ? "Whole-desktop foreground: it may bring apps forward and take keyboard or pointer focus for this purpose."
      : "Background-only: it cannot bring apps forward or take keyboard or pointer focus."
  }`,
  details: [
    ...(input.foreground
      ? [
          "Foreground input can briefly take and return the screen. Only one input action already sent under live approval may finish its own focus return. GOAT does not restore focus when approval ends, and refuses later foreground input until new approval. Pause, Stop, takeover, control replacement or turn end revokes foreground authority and requires approval again.",
        ]
      : []),
    input.apps === undefined
      ? "Approving admits this thread's turns until the request expires. It does not approve each action, and anything the screen shows can be clicked or typed into. You can end it early from this request in the thread, and turning computer use off ends it too."
      : "Approving admits this thread's turns to these apps' windows until the request expires. It does not approve each action, and anything those windows show can be clicked or typed into. You can end it early from this request in the thread, and turning computer use off ends it too.",
  ].join("\n\n"),
});

export const requestComputerUse = Effect.fn("ComputerUse.request")(function* (input: {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly request: ComputerUseRequestInput;
  /**
   * How long this call waits in its turn for a person's answer. Without it, or when this turn
   * has no cua-driver tools to go on with, the call returns at once and the answer wakes the
   * thread instead.
   */
  readonly wait?: Duration.Duration;
}) {
  const foreground = input.request.foreground === true;
  const wanted = input.request.apps;
  if (foreground && wanted !== undefined)
    return {
      kind: "refused",
      reason: "unsupported",
      message:
        "Foreground approval supports whole-desktop access only. Omit apps to ask explicitly for the whole desktop, or omit foreground for background-only access to these apps. No app scope has been broadened.",
    } satisfies ComputerUseRequestResult;
  const cua = yield* Effect.serviceOption(CuaDriver.CuaDriver);
  if (Option.isNone(cua) || !(yield* cua.value.enabled))
    return {
      kind: "refused",
      reason: "disabled",
      message: "Computer use is off on this host. A person turns it on in Settings.",
    } satisfies ComputerUseRequestResult;
  // An approval would not help: the desktop will not start the driver until macOS allows it, or
  // until the Windows helper can use the desktop. A block newer readiness has cleared no longer
  // refuses.
  const cached = yield* cua.value.block;
  // A Windows desktop can recover with nothing reporting it (the person unlocks the screen), so
  // the desktop's block is checked again with one bounded start before it refuses. Only a person
  // changes a macOS grant, so that block refuses as it is.
  const block =
    cached?.reason === "desktopUnavailable"
      ? yield* cua.value.acquire.pipe(
          Effect.timeoutOption("35 seconds"),
          Effect.andThen(cua.value.block),
        )
      : cached;
  if (block !== undefined)
    return {
      kind: "refused",
      reason: "not_granted",
      block,
      message: cuaAgentBlockMessage(block),
    } satisfies ComputerUseRequestResult;
  if (wanted !== undefined) {
    const listed = yield* cua.value.listedApps;
    if (Option.isSome(listed)) {
      const known = new Set(listed.value.map((app) => app.toLowerCase()));
      const unknownApps = wanted.filter((app) => !known.has(app.toLowerCase()));
      if (unknownApps.length > 0)
        return {
          kind: "refused",
          reason: "unknown_app",
          unknownApps,
          message: `This host does not list these app ids: ${unknownApps.join(", ")}. Name apps by the bundle_id list_apps reports (on Windows usually the executable path), or by its listed name when it has no bundle_id. Never use a window title. Call list_apps and ask again with its ids; if the app is not open, open it first.`,
        } satisfies ComputerUseRequestResult;
    }
  }
  const leases = yield* ComputerUseLeases.ComputerUseLeases;
  // Admissions to different apps hold at once; an app, or the whole screen, is one thread's.
  const held = yield* leases.holder(input.threadId, input.request.apps);
  if (Option.isSome(held))
    return {
      kind: "refused",
      reason: "held",
      holderThreadId: held.value.threadId,
      message: `${describeHolder(held.value)} ${
        held.value.apps === undefined
          ? "Ask again after it ends."
          : "Ask only for apps it does not hold, or ask again after it ends."
      }`,
    } satisfies ComputerUseRequestResult;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const view = yield* threads.getThreadSnapshot(input.threadId);
  // The run this call is part of; a queued run behind it has not started.
  const run = ThreadManagement.latestActiveRun(view.projection);
  const origin = yield* computerUseOrigin(
    projectionOriginReads({
      getThreadRecords: (id, fields, filter) => threads.getThreadRecords(id, fields, filter),
      channelOrigin: leases.channelOrigin,
    }),
    { threadId: input.threadId, ...(run === undefined ? {} : { runId: run.id }) },
  );
  const detection = yield* leases.detection;
  if (origin._tag === "unattended" && !detection.privateMode)
    return {
      kind: "refused",
      reason: "detection_unsupported",
      message:
        "This host cannot yet tell when a person types a secret, so work that runs on its own cannot use the screen here. A person can still run computer use from a thread they direct.",
    } satisfies ComputerUseRequestResult;
  // This run's own control, while an agent can act through it.
  const current = Option.filter(
    yield* leases.attached(input.threadId),
    (control) => run !== undefined && control.runId === run.id,
  );
  if (
    Option.isSome(current) &&
    current.value.everyApp &&
    (!foreground || (yield* leases.foregroundAvailable(input.threadId, input.request.purpose)))
  )
    return {
      kind: "available",
      message: foreground
        ? "This thread runs in full access: this turn can bring apps forward and take keyboard or pointer focus without approval. Tell the person first that the screen may briefly be taken and returned."
        : "This thread runs in full access: this turn can act on every app without approval.",
    } satisfies ComputerUseRequestResult;
  const own = yield* leases.active(input.threadId);
  // A live admission answers the request only when it already covers what is asked.
  const granted = Option.isSome(own) ? own.value.apps : [];
  const covered =
    Option.isSome(own) &&
    (granted === undefined ||
      (wanted !== undefined &&
        wanted.every((app) => granted.some((name) => name.toLowerCase() === app.toLowerCase()))));
  const foregroundCovered =
    foreground && (yield* leases.foregroundAvailable(input.threadId, input.request.purpose));
  if (Option.isSome(own) && (foreground ? foregroundCovered : covered))
    return {
      kind: "available",
      message: foreground
        ? "This thread already has live whole-desktop foreground approval for this purpose until its approved expiry. Pause, Stop, control replacement or turn end requires new foreground approval. The cua-driver tools are attached from your next turn if they are not already."
        : `This thread is admitted${own.value.apps === undefined ? "" : ` for ${own.value.apps.join(", ")}`} until ${DateTime.formatIso(own.value.expiresAt)}. The cua-driver tools are attached from your next turn if they are not already.`,
    } satisfies ComputerUseRequestResult;

  if (!run || run.rootNodeId === null)
    return {
      kind: "refused",
      reason: "unsupported",
      message: "Ask from a running turn of this thread.",
    } satisfies ComputerUseRequestResult;
  const minutes = input.request.minutes ?? DEFAULT_MINUTES;
  const expiresAt = DateTime.add(yield* DateTime.now, { minutes });
  const host = yield* HostProcess.Hostname;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const text = grantText({
    title: view.projection.thread.title.trim() || "A thread",
    turn: run.ordinal,
    apps: wanted,
    minutes,
    purpose: input.request.purpose,
    foreground,
  });
  const handoffs = yield* Handoffs.Handoffs;
  const handoff = yield* handoffs.create({
    kind: "approval",
    title:
      wanted === undefined
        ? `Allow computer use on ${host}?`
        : `Allow ${wanted.join(", ")} on ${host}?`,
    reason: text.reason,
    requestedBy: {
      threadId: input.threadId,
      providerInstanceId: input.providerInstanceId,
      path: COMPUTER_USE_GRANT_HANDOFF_PATH,
    },
    target: { environmentId, path: COMPUTER_USE_GRANT_HANDOFF_PATH },
    runId: run.id,
    nodeId: run.rootNodeId,
    human: { location: text.details },
    args: {
      purpose: input.request.purpose,
      minutes,
      ...(foreground ? { foreground: true } : {}),
      ...(wanted === undefined ? {} : { apps: wanted }),
    },
    expiresAt,
    ...(foreground
      ? { computerUseForeground: { purpose: input.request.purpose, target: "desktop" as const } }
      : {}),
    ...(wanted === undefined ? {} : { apps: wanted }),
  });
  // A repeated request returns the pending handoff with its original expiry.
  const approvedUntil = DateTime.formatIso(handoff.expiresAt ?? expiresAt);
  if (input.wait !== undefined && origin._tag === "interactive" && Option.isSome(current)) {
    const controlId = current.value.controlId;
    // Under the Handoffs lock: whether this turn can still use the answer it is given.
    const settle = Effect.fn("ComputerUse.settleAnswer")(
      function* (resolved: Handoff) {
        const { runs } = yield* threads.getThreadRecords(input.threadId, ["runs"], {
          runIds: [run.id],
        });
        const live = runs.find((candidate) => candidate.id === run.id);
        if (live === undefined || !ThreadManagement.isActiveRun(live)) return false;
        if (resolved.state !== "completed") return true;
        const now = yield* leases.attached(input.threadId);
        if (Option.isNone(now) || now.value.controlId !== controlId) return false;
        if (foreground)
          return yield* leases.foregroundAvailable(input.threadId, input.request.purpose);
        const state = yield* leases.controlState(input.threadId, controlId);
        if (state._tag !== "active") return false;
        const held = state.apps;
        if (held === undefined) return true;
        return (
          wanted !== undefined &&
          wanted.every((app) => held.some((name) => name.toLowerCase() === app.toLowerCase()))
        );
      },
      Effect.orElseSucceed(() => false),
    );
    const answer = yield* handoffs.awaitComputerUseAnswer(
      {
        threadId: input.threadId,
        handoffId: handoff.handoffId,
        until: DateTime.add(yield* DateTime.now, { milliseconds: Duration.toMillis(input.wait) }),
      },
      settle,
    );
    return answered(answer, { wanted, foreground, approvedUntil });
  }
  return {
    kind: "needs_human",
    handoff,
    // Calling again after approval reads the admission and returns available.
    next: { after: "approval", call: "goat_computer_use_request" },
    message: `A person must approve this in a GOAT app; a reply in a chat channel does not count. If they approve before ${approvedUntil}, your next turn in this thread has the cua-driver tools until then. End this turn now.`,
  } satisfies ComputerUseRequestResult;
});

/** What the waiting call tells the agent about the answer it got, or did not get. */
const answered = (
  answer: ComputerUseAnswer,
  asked: {
    readonly wanted: ReadonlyArray<string> | undefined;
    readonly foreground: boolean;
    readonly approvedUntil: string;
  },
): ComputerUseRequestResult => {
  const { handoff, usable } = answer;
  const refused = (
    reason: "declined" | "cancelled" | "expired" | "superseded" | "interrupted",
    message: string,
  ) => ({ kind: "refused", reason, message }) satisfies ComputerUseRequestResult;
  switch (handoff.state) {
    case "completed": {
      if (!usable)
        return refused(
          "interrupted",
          "A person approved this, but this turn's computer use was stopped, paused or replaced meanwhile. Do not act on the screen in this turn; a later turn has the approval while it lasts.",
        );
      const until =
        handoff.expiresAt === null ? asked.approvedUntil : DateTime.formatIso(handoff.expiresAt);
      const scope = asked.wanted === undefined ? "the whole screen" : asked.wanted.join(", ");
      return {
        kind: "available",
        message: asked.foreground
          ? "A person approved foreground input for this purpose until " +
            until +
            ". Go on in this turn; tell the person first that the screen may briefly be taken and returned. Pause, Stop or the end of this turn needs a new approval."
          : "A person approved " +
            scope +
            " until " +
            until +
            ". Go on in this turn: the cua-driver tools can act on it now.",
      };
    }
    case "declined":
      return refused(
        "declined",
        "A person declined this request. Do not act on these apps; tell the person what you could not do, or ask what to do instead.",
      );
    case "cancelled":
      return handoff.actor.type === "agent"
        ? refused(
            "superseded",
            "A newer request from this thread replaced this one; its answer is the one that counts.",
          )
        : refused(
            "cancelled",
            "A person cancelled this request without approving it. Ask again only if the person still wants it.",
          );
    case "expired":
      return refused(
        "expired",
        "This request expired without an answer. Ask again only if the person still wants it.",
      );
    default:
      return {
        kind: "needs_human",
        handoff: handoffSummary(handoff),
        waitTimedOut: true,
        next: { after: "approval", call: "goat_computer_use_request" },
        message:
          "No answer yet. The request stays open until " +
          asked.approvedUntil +
          "; call goat_computer_use_request again with the same arguments to keep waiting, or end this turn and GOAT wakes this thread when a person answers.",
      };
  }
};
