/**
 * GOAT Bot's read of a work thread on another machine, over the connection GOAT already holds.
 * Past a short deadline, or when the host refuses, cannot be reached, or is not shown to be the
 * GOAT that ran the work, the answer is the task's reports and why.
 */
import type { ChannelRequester, ChannelTask, EnvironmentId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as LinkedHosts from "../linkedHosts/LinkedHosts.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import { lowerRuntimeMode } from "./ChannelGateway.ts";
import {
  RECALL_MESSAGE_CHARS,
  RECALL_RESULT_CHARS,
  RECALL_THREAD_MESSAGES,
  taskDigest,
  threadDigest,
} from "./channelBotRecall.ts";

/** How long a read waits for another machine; inside the reception's 5 s limit for one read. */
export const REMOTE_RECALL_TIMEOUT_MS = 3_000;
/** The newest items read there; plans share the view, so a few times the messages kept. */
const REMOTE_RECALL_ITEMS = RECALL_THREAD_MESSAGES * 4;

/**
 * Only what the digest uses, so a host whose other thread fields differ still reads. A host that
 * ignored tail sends no tailStartPosition and would show the thread's oldest items instead.
 */
const RemoteThreadMessages = Schema.Struct({
  thread: Schema.Struct({ title: Schema.String }),
  items: Schema.Array(
    Schema.Struct({
      type: Schema.String,
      text: Schema.NullOr(Schema.String),
      updatedAt: Schema.String,
    }),
  ),
  tailStartPosition: Schema.NullOr(Schema.Number),
});
const decodeMessages = Schema.decodeUnknownEffect(RemoteThreadMessages);

type Miss =
  | SshRemoteDispatch.SshRemoteDispatchError["reason"]
  | "timeout"
  | "undecodable"
  | "unverified";

const missLine = (host: string, miss: Miss) => {
  switch (miss) {
    case "timeout":
      return "Its thread on " + host + " did not answer in time";
    case "unverified":
      return host + " may no longer be the GOAT that ran it";
    case "undecodable":
      return "Its thread on " + host + " could not be read here";
    case "remote_refused":
    case "remote_outdated":
    case "caller_changed":
      return "GOAT on " + host + " refused to show its thread";
    case "host_unknown":
    case "invalid_request":
      return host + " is not connected to this machine";
    default:
      return "Its thread on " + host + " could not be reached";
  }
};

type Link = Option.Option<LinkedHosts.LinkedHostCredential>;

/** Every save exchanges a new token, so a link replaced and restored is not the same link. */
const sameLink = (left: Link, right: Link, environmentId: EnvironmentId) =>
  Option.isSome(left) &&
  Option.isSome(right) &&
  left.value.token === right.value.token &&
  left.value.host.baseUrl === right.value.host.baseUrl &&
  left.value.host.environmentId === right.value.host.environmentId &&
  left.value.host.environmentId === environmentId;

/**
 * Reads, for a requester who may already see the task, the task and the newest messages of its
 * thread on another machine. That host applies its own authority, at no more than the requester's
 * or the task's runtime-mode ceiling. Nothing there is prepared or woken; this machine asks once
 * and keeps nothing.
 */
export const makeRemoteThreadRecall = Effect.gen(function* () {
  const ssh = yield* SshRemoteDispatch.SshRemoteDispatch;
  const linkedHosts = yield* Effect.serviceOption(LinkedHosts.LinkedHosts);
  const linkFor = (host: string) =>
    Option.isNone(linkedHosts)
      ? Effect.fail<Miss>("unverified")
      : linkedHosts.value.find(host).pipe(Effect.mapError((): Miss => "unverified"));

  return Effect.fn("ChannelRemoteRecall.read")(function* (
    task: ChannelTask,
    worker: {
      readonly host: string;
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
    },
    viewer: ChannelRequester,
  ) {
    const digest = taskDigest(task);
    // Over SSH the host names its environment after the read; over a link it never does.
    let answeredBy: EnvironmentId | null | undefined;
    const read = yield* Effect.gen(function* () {
      const before = yield* linkFor(worker.host).pipe(
        Effect.orElseSucceed(() => Option.none<LinkedHosts.LinkedHostCredential>()),
      );
      if (Option.isSome(before) && before.value.host.environmentId !== worker.environmentId)
        return yield* Effect.fail<Miss>("unverified");
      const raw = yield* ssh
        .callHostTool(
          {
            host: worker.host,
            tool: "goat_thread_read",
            arguments: {
              threadId: worker.threadId,
              view: "messages",
              tail: REMOTE_RECALL_ITEMS,
              runLimit: 1,
              // One past the cut, so a message the host shortened still ends with an ellipsis.
              maxCharsPerItem: RECALL_MESSAGE_CHARS + 1,
            },
            writes: false,
            requireReady: true,
            // Longer than the deadline below, so a slow host is always reported as one.
            timeoutMs: REMOTE_RECALL_TIMEOUT_MS + 1_000,
            onResolvedEnvironmentId: (id) => {
              answeredBy = id;
            },
          },
          Effect.succeed(
            lowerRuntimeMode(viewer.runtimeModeCeiling, task.requester.runtimeModeCeiling),
          ),
        )
        .pipe(Effect.mapError((error): Miss => error.reason));
      const verified =
        answeredBy !== undefined
          ? answeredBy === worker.environmentId
          : sameLink(before, yield* linkFor(worker.host), worker.environmentId);
      if (!verified) return yield* Effect.fail<Miss>("unverified");
      return yield* decodeMessages(raw).pipe(Effect.mapError((): Miss => "undecodable"));
    }).pipe(
      Effect.timeoutOption(REMOTE_RECALL_TIMEOUT_MS),
      Effect.map(Option.match({ onNone: (): Miss => "timeout", onSome: (found) => found })),
      Effect.catch((miss: Miss) => Effect.succeed(miss)),
    );
    if (typeof read === "string") {
      yield* Effect.logInfo("GOAT Bot answered from a remote task's reports", {
        host: worker.host,
        reason: read,
      });
      return digest + "\n" + missLine(worker.host, read) + "; this is from its reports.";
    }
    const messages = read.items.slice(-REMOTE_RECALL_ITEMS).flatMap((item) =>
      (item.type === "user_message" || item.type === "assistant_message") && item.text !== null
        ? [
            {
              role: item.type === "user_message" ? ("user" as const) : ("assistant" as const),
              text: item.text,
              createdAt: item.updatedAt,
            },
          ]
        : [],
    );
    return (
      digest +
      "\n" +
      threadDigest(
        read.thread.title || task.title,
        messages,
        RECALL_RESULT_CHARS - digest.length - 1,
      )
    );
  });
});
