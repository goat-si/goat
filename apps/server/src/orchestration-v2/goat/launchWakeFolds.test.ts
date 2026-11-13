import {
  CommandId,
  MessageId,
  type OrchestrationV2Command,
  type OrchestrationV2Notification,
  type OrchestrationV2ThreadProjection,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { HOST_PRESSURE_MESSAGE_PREFIX } from "../../fleet/pressure/pressureModel.ts";
import { finishedWake, newLaunchWatch } from "../../mcp/launchWatch.ts";
import { foldIntoQueuedNotice } from "../TurnDigest.ts";

type Projection = Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;
type Dispatch = Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }>;
type Queued = {
  readonly id: string;
  readonly text: string;
  readonly createdBy: "agent" | "user";
  readonly notification?: OrchestrationV2Notification;
  readonly status?: "queued" | "starting" | "running";
};

const session = ThreadId.make("goat-bot-session:folds");
const ordinary = ThreadId.make("thread:supervisor");
const now = DateTime.makeUnsafe("2026-10-12T00:00:00.000Z");

/** A launched thread's completion wake, stamped with its launching run when one is given. */
const wake = (lane: string, launcher: ThreadId, launcherRunId?: string) => {
  const built = finishedWake({
    watch: newLaunchWatch({
      launcherThreadId: launcher,
      ...(launcherRunId === undefined ? {} : { launcherRunId: RunId.make(launcherRunId) }),
      host: null,
      threadId: ThreadId.make(`thread:${lane}`),
      projectId: null,
      title: lane,
      incarnation: "test",
      notifyWebhook: false,
      now: 0,
    }),
    runId: RunId.make(`run:${lane}`),
    status: "completed",
    title: lane,
    branch: null,
    worktreePath: null,
    excerpt: `${lane} is done.`,
  });
  return { id: built.messageId as string, text: built.text, notification: built.notification };
};

const pressure = (level: string) => ({
  id: `${HOST_PRESSURE_MESSAGE_PREFIX}box-a:wake:${level}`,
  text: `box-a is ${level}.`,
  notification: {
    source: { kind: "monitor" },
    outcome: "updated",
    summary: `box-a ${level}`,
  } satisfies OrchestrationV2Notification,
});

/** A thread whose first run is running, with these messages queued behind it in order. */
const queue = (items: ReadonlyArray<Queued>): Projection =>
  ({
    runs: [
      { id: "run:active", ordinal: 0, status: "running", userMessageId: "message:active" },
      ...items.map((item, index) => ({
        id: `run:queued-${index}`,
        ordinal: index + 1,
        status: item.status ?? "queued",
        userMessageId: item.id,
        rootNodeId: null,
        providerInstanceId: "codex",
      })),
    ],
    messages: items.map((item) => ({
      id: item.id,
      text: item.text,
      createdBy: item.createdBy,
      creationSource: item.createdBy === "agent" ? "server" : "web",
      ...(item.notification === undefined ? {} : { notification: item.notification }),
    })),
  }) as unknown as Projection;

const asNotice = (notice: {
  readonly id: string;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
}): Queued => ({
  ...notice,
  createdBy: "agent",
});

const dispatch = (
  threadId: ThreadId,
  notice: {
    readonly id: string;
    readonly text: string;
    readonly notification: OrchestrationV2Notification;
  },
): Dispatch => ({
  type: "message.dispatch",
  commandId: CommandId.make(`command:${notice.id}`),
  threadId,
  messageId: MessageId.make(notice.id),
  text: notice.text,
  notification: notice.notification,
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
  createdBy: "agent",
  creationSource: "server",
});

const userMessage: Queued = { id: "message:user", text: "And the docs.", createdBy: "user" };

describe("launch wakes on task threads fold only by launching run", () => {
  it("invariant: a stamped wake never folds into another launching run's queued turn", () => {
    const first = wake("a", session, "run:one");
    expect(first.notification.aboutRunId).toBe("run:one");
    const fold = foldIntoQueuedNotice(
      queue([asNotice(first)]),
      dispatch(session, wake("b", session, "run:two")),
      now,
    );
    expect(fold).toBeUndefined();
  });

  it("contract: a stamped wake queues its own turn when the tail is a user message or another notice kind", () => {
    const next = dispatch(session, wake("b", session, "run:one"));
    expect(foldIntoQueuedNotice(queue([userMessage]), next, now)).toBeUndefined();
    expect(
      foldIntoQueuedNotice(queue([asNotice(pressure("elevated"))]), next, now),
    ).toBeUndefined();
  });

  it("contract: a same-run wake from another source kind does not fold", () => {
    const first = wake("a", session, "run:one");
    const other = wake("b", session, "run:one");
    const monitor = {
      ...other,
      notification: { ...other.notification, source: { kind: "monitor" as const } },
    };
    expect(
      foldIntoQueuedNotice(queue([asNotice(first)]), dispatch(session, monitor), now),
    ).toBeUndefined();
  });

  it("invariant: a stamped wake never folds past a user message queued after its run's turn", () => {
    const fold = foldIntoQueuedNotice(
      queue([asNotice(wake("a", session, "run:one")), userMessage]),
      dispatch(session, wake("b", session, "run:one")),
      now,
    );
    expect(fold).toBeUndefined();
  });

  it("contract: another notice kind after a launching run's turn does not stop its next wake folding", () => {
    const fold = foldIntoQueuedNotice(
      queue([asNotice(wake("a", session, "run:one")), asNotice(pressure("elevated"))]),
      dispatch(session, wake("b", session, "run:one")),
      now,
    );
    expect(fold?.runId).toBe("run:queued-0");
  });

  it("invariant: another notice behind a stamped wake queues its own turn", () => {
    const fold = foldIntoQueuedNotice(
      queue([asNotice(wake("a", session, "run:one"))]),
      dispatch(session, pressure("critical")),
      now,
    );
    expect(fold).toBeUndefined();
  });

  it("contract: notices away from stamped wakes fold into the tail as before", () => {
    const fold = foldIntoQueuedNotice(
      queue([asNotice(wake("a", session, "run:one")), asNotice(pressure("elevated"))]),
      dispatch(session, pressure("critical")),
      now,
    );
    expect(fold?.runId).toBe("run:queued-1");
  });

  it.each(["starting", "running"] as const)(
    "invariant: a wake never folds into a launching run's turn that is %s",
    (status) => {
      const fold = foldIntoQueuedNotice(
        queue([{ ...asNotice(wake("a", session, "run:one")), status }]),
        dispatch(session, wake("b", session, "run:one")),
        now,
      );
      expect(fold).toBeUndefined();
    },
  );

  it("regression: an ordinary thread's unstamped wakes still fold into the tail notice", () => {
    const first = wake("a", ordinary, "run:one");
    expect(first.notification.aboutRunId).toBeUndefined();
    const fold = foldIntoQueuedNotice(
      queue([asNotice(first)]),
      dispatch(ordinary, wake("b", ordinary, "run:two")),
      now,
    );
    expect(fold?.runId).toBe("run:queued-0");
  });
});
