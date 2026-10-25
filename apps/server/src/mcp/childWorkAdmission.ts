/**
 * childWorkAdmission - the MCP surfaces' shared bridge to ChannelChildWork. Each launch surface
 * (delegate_task, goat_thread_launch, goat_ssh_thread_launch) admits channel-owned callers
 * through the same code so capacity, depth, and durable identity behave identically everywhere;
 * an ordinary caller gets undefined and its surface behaves exactly as before.
 *
 * @module childWorkAdmission
 */
import {
  type ChannelChildWorkDestination,
  OrchestratorMcpFailure,
  type SshLaunchWorkspace,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as Option from "effect/Option";

import * as ChannelChildWork from "../channels/ChannelChildWork.ts";
import { childWorkCorrelationIdFor } from "../channels/channelIds.ts";

const childWorkFailure = (error: ChannelChildWork.ChannelChildWorkError): OrchestratorMcpFailure =>
  error.reason === "at_capacity"
    ? new OrchestratorMcpFailure({ code: "capacity_exceeded", message: error.detail })
    : error.reason === "depth_exceeded"
      ? new OrchestratorMcpFailure({ code: "capability_denied", message: error.detail })
      : new OrchestratorMcpFailure({ code: "orchestration_error", message: error.detail });

/** The admission shapes a surface acts on; "not_channel_owned" never leaves this module. */
export type ChannelChildAdmission = Exclude<
  ChannelChildWork.ChannelChildWorkAdmission,
  { readonly _tag: "not_channel_owned" }
>;

const visible = (
  admission: ChannelChildWork.ChannelChildWorkAdmission,
): ChannelChildAdmission | undefined =>
  admission._tag === "not_channel_owned" ? undefined : admission;

/** The one admission call, mapped to the surfaces' failure shape. */
export const admitChildWork = Effect.fn("childWorkAdmission.admitChildWork")(function* (
  childWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>,
  input: {
    readonly callerThreadId: ThreadId;
    readonly surface: "delegate_local" | "delegate_remote" | "thread_launch" | "ssh_thread_launch";
    readonly prompt: string;
    /** The launch target's canonical parts, joined in order. */
    readonly destinationKey: string;
    readonly destinationHint?: string | undefined;
    readonly clientRequestId?: string | undefined;
  },
) {
  if (childWork._tag === "None") return undefined;
  const admission = yield* childWork.value
    .admit({
      callerThreadId: input.callerThreadId,
      surface: input.surface,
      prompt: input.prompt,
      destinationKey: input.destinationKey,
      ...(input.destinationHint === undefined ? {} : { destinationHint: input.destinationHint }),
      ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
    })
    .pipe(Effect.mapError(childWorkFailure));
  return visible(admission);
});

/**
 * delegate_task's admission, local or remote; the destination key covers host, cwd/workspace,
 * model, isolation, and role, so the same prompt aimed at another target is another request.
 */
export const admitDelegate = Effect.fn("childWorkAdmission.admitDelegate")(function* (
  childWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>,
  input: {
    readonly callerThreadId: ThreadId;
    readonly prompt: string;
    readonly clientRequestId?: string | undefined;
    readonly target?:
      | {
          readonly providerInstanceId?: string | undefined;
          readonly model?: string | undefined;
          readonly driverKind?: string | undefined;
        }
      | undefined;
    readonly isolation?: string | undefined;
    readonly role?: string | undefined;
    readonly remote?:
      | {
          readonly host: string;
          readonly cwd: string;
          readonly workspace?: SshLaunchWorkspace | undefined;
        }
      | undefined;
  },
) {
  const remote = input.remote;
  const destinationKey =
    remote === undefined
      ? [
          input.target?.providerInstanceId ?? "",
          input.target?.model ?? "",
          input.target?.driverKind ?? "",
          input.isolation ?? "",
          input.role ?? "",
        ].join("\u0000")
      : [
          remote.host,
          remote.cwd,
          remote.workspace === undefined
            ? ""
            : remote.workspace.type === "worktree"
              ? "worktree:" + remote.workspace.branch
              : "cwd",
          input.target?.providerInstanceId ?? "",
          input.target?.model ?? "",
          input.target?.driverKind ?? "",
          input.role ?? "",
        ].join("\u0000");
  return yield* admitChildWork(childWork, {
    callerThreadId: input.callerThreadId,
    surface: remote === undefined ? "delegate_local" : "delegate_remote",
    prompt: input.prompt,
    destinationKey,
    ...(remote === undefined ? {} : { destinationHint: remote.host + ":" + remote.cwd }),
    ...(input.clientRequestId === undefined ? {} : { clientRequestId: input.clientRequestId }),
  });
});

/**
 * Runs a record transition for an admitted caller and no-ops otherwise. The transitions never
 * fail (a lost compare-and-set means another writer settled the record first), so surfaces stay
 * on their own error paths.
 */
const settleChildWork = (
  childWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>,
  admission: ChannelChildAdmission | undefined,
  settle: (
    service: ChannelChildWork.ChannelChildWork["Service"],
    record: ChannelChildAdmission["record"],
  ) => Effect.Effect<void, never>,
) =>
  admission === undefined || childWork._tag === "None"
    ? Effect.void
    : settle(childWork.value, admission.record);

/** The launch failed before its work committed; the admission's capacity returns. */
export const releaseChildWork = (
  childWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>,
  admission: ChannelChildAdmission | undefined,
) => settleChildWork(childWork, admission, (child, record) => child.markReleased(record));

/**
 * reserved -> launched, at the destination the surface computes, held in flight until the
 * enclosing scope closes; the scope must cover the launch up to its commit. A refused claim
 * fails, and the surface launches nothing: a task stop released the reservation, or the write
 * failed and the still-reserved record is released here.
 */
export const launchChildWork = Effect.fn("childWorkAdmission.launchChildWork")(function* (
  childWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>,
  admission: ChannelChildAdmission | undefined,
  destination: ChannelChildWorkDestination,
) {
  if (admission === undefined || childWork._tag === "None") return;
  if (yield* childWork.value.claimLaunch(admission.record, destination)) return;
  yield* childWork.value.releaseReserved(admission.record);
  return yield* new OrchestratorMcpFailure({
    code: "orchestration_error",
    message:
      "The launch could not claim its reserved slot (the work was stopped, or the record could" +
      " not be written), so nothing was launched.",
  });
});

/** A remote launch's destination is always the record-derived correlation id plus its host. */
export const launchRemoteChildWork = (
  childWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>,
  admission: ChannelChildAdmission | undefined,
  host: string,
) =>
  launchChildWork(childWork, admission, {
    ...(admission === undefined
      ? {}
      : { correlationId: childWorkCorrelationIdFor(admission.record.childWorkId) }),
    host,
  });

/** The destination accepted the work; without one, the launch-time destination stands. */
export const bindChildWork = (
  childWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>,
  admission: ChannelChildAdmission | undefined,
  destination?: ChannelChildWorkDestination,
) =>
  settleChildWork(childWork, admission, (child, record) =>
    destination === undefined ? child.markBound(record) : child.markBound(record, destination),
  );

/** The correlation id an admitted caller's remote launch persists under. */
export const admissionCorrelationId = (admission: ChannelChildAdmission | undefined) =>
  admission === undefined ? undefined : childWorkCorrelationIdFor(admission.record.childWorkId);

/**
 * The conflict a surface raises for an "existing" admission: whatever state the record is in,
 * this request already had its one admission, so launching again would double-spend capacity.
 */
export const existingChildWorkConflict = (admission: ChannelChildAdmission) => {
  const record = admission.record;
  const destination = record.destination;
  const pointer =
    destination?.threadId !== undefined
      ? ", thread " + destination.threadId
      : destination?.correlationId !== undefined
        ? ", correlation id " + destination.correlationId
        : record.destinationHint === undefined
          ? ""
          : ", destination " + record.destinationHint;
  return new OrchestratorMcpFailure({
    code: "conflict",
    message:
      "This exact request was already admitted (state " +
      record.state +
      pointer +
      "). Follow the existing child work, or change the request to launch anew.",
  });
};

/**
 * Releases the admission's reservation on a failure path, but only while the record is still
 * reserved: once a launch was attempted, the launch paths' own classification decides.
 */
export const releaseReservation = (
  childWork: Option.Option<ChannelChildWork.ChannelChildWork["Service"]>,
  admission: ChannelChildAdmission | undefined,
) => settleChildWork(childWork, admission, (child, record) => child.releaseReserved(record));
