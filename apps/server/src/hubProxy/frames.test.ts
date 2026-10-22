import { expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  EnvironmentAuthorizationError,
  OrchestrationV2Command,
  WS_METHODS,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import { Rpc, RpcClient, RpcGroup, RpcMessage, RpcSerialization } from "effect/rpc";

import { createAttachmentId, createPendingAttachmentId } from "../attachmentStore.ts";
import { gateClientFrame, hubProxyRefusal, refuseProxiedCall } from "./frames.ts";

const read = "orchestration.subscribeThread";
const write = "orchestration.dispatchCommand";
const admit = (method: string, payload: unknown) =>
  refuseProxiedCall(["orchestration:read"], method, payload);
const request = (id: string | number, tag = read) => ({
  _tag: "Request",
  id,
  tag,
  payload: {},
  headers: [],
});

it("preserves the original string and binary frame when every request is admitted", () => {
  for (const frame of [
    `  ${JSON.stringify([request(1), request("2")])}  `,
    new TextEncoder().encode(JSON.stringify(request(3))),
  ]) {
    const gated = gateClientFrame(frame, admit);
    expect(gated.forward).toBe(frame);
    expect(gated.replies).toEqual([]);
  }
});

it("refuses only the forbidden request in a mixed batch and serializes the rest", () => {
  const kept = [request(1), { _tag: "Ping" }, request("3")];
  const gated = gateClientFrame(JSON.stringify([...kept, request(2, write)]), admit);
  expect(JSON.parse(String(gated.forward))).toEqual(kept);
  expect(gated.replies.map((reply) => JSON.parse(reply))).toMatchObject([
    {
      _tag: "Exit",
      requestId: 2,
      exit: {
        _tag: "Failure",
        cause: [{ _tag: "Fail", error: { requiredScope: "orchestration:operate" } }],
      },
    },
  ]);
});

it("keeps numeric and string refusal request ids distinct", () => {
  const gated = gateClientFrame(JSON.stringify([request(7, write), request("7", write)]), admit);
  expect(gated.forward).toBeUndefined();
  expect(gated.replies.map((reply) => JSON.parse(reply).requestId)).toEqual([7, "7"]);
});

it("passes Ping, Ack, Interrupt and Eof unchanged", () => {
  const frame = JSON.stringify([
    { _tag: "Ping" },
    { _tag: "Ack", requestId: 1 },
    { _tag: "Interrupt", requestId: "2" },
    { _tag: "Eof" },
  ]);
  expect(gateClientFrame(frame, admit)).toEqual({ forward: frame, replies: [] });
});

it("drops unparseable frames and malformed request envelopes", () => {
  for (const frame of ["{", "not json", "null", JSON.stringify({ ...request(1, write), id: {} })]) {
    expect(gateClientFrame(frame, admit)).toEqual({ forward: undefined, replies: [] });
  }
});

it("admits read subscriptions and refuses dispatch with the missing operate scope", () => {
  expect(admit(read, {})).toBeUndefined();
  expect(admit(write, {})).toMatchObject({
    _tag: "EnvironmentAuthorizationError",
    requiredScope: "orchestration:operate",
  });
});

it("refuses unknown methods with hub:proxy", () => {
  expect(admit("unknown.method", {})).toMatchObject({ requiredScope: "hub:proxy" });
});

it("enforces the hub method policy even when the caller supplies settings:write", () => {
  expect(
    refuseProxiedCall(AuthStandardClientScopes, WS_METHODS.connectionCatalogServe, {}),
  ).toMatchObject({ requiredScope: "hub:proxy" });
});

it.effect(
  "decodes gate refusal JSON into typed RPC errors for two numeric ids and a string id",
  () =>
    Effect.gen(function* () {
      const group = RpcGroup.make(
        Rpc.make(write, {
          success: Schema.Void,
          error: EnvironmentAuthorizationError,
        }),
      );
      const responses = yield* Queue.unbounded<string>();
      const ids = [41, 42, "42"];
      const observed: Array<string | number> = [];
      const send = (frame: string | Uint8Array | Socket.CloseEvent) =>
        Effect.gen(function* () {
          if (Socket.isCloseEvent(frame)) return;
          const gated = gateClientFrame(frame, admit);
          for (const reply of gated.replies) {
            observed.push(JSON.parse(reply).requestId);
            yield* Queue.offer(responses, reply);
          }
        });
      const socket = Socket.make({
        reader: Effect.succeed({
          pull: Queue.take(responses).pipe(Effect.map((frame) => [frame] as const)),
          upgrade: () => Effect.void,
        }),
        writer: Effect.succeed({
          write: send,
          writeAll: (frames) => Effect.forEach(frames, send, { discard: true }),
        }),
      });
      const protocol = yield* RpcClient.makeProtocolSocket().pipe(
        Effect.provideService(Socket.Socket, socket),
        Effect.provide(RpcSerialization.layerJson),
      );
      const client = yield* RpcClient.make(group, {
        generateRequestId: () => RpcMessage.RequestId(ids.shift()!),
      }).pipe(Effect.provideService(RpcClient.Protocol, protocol));
      for (let i = 0; i < 3; i++) {
        const error = yield* Effect.flip(client[write]());
        expect(error).toBeInstanceOf(EnvironmentAuthorizationError);
        expect(error).toMatchObject({ requiredScope: "orchestration:operate" });
      }
      expect(observed).toEqual([41, 42, "42"]);
      expect(hubProxyRefusal("denied").requiredScope).toBe("hub:proxy");
    }).pipe(Effect.scoped),
);

const operate = (payload: unknown) =>
  refuseProxiedCall(["orchestration:read", "orchestration:operate"], write, payload);
const followUp = {
  type: "message.dispatch",
  commandId: "c1",
  threadId: "t1",
  messageId: "m1",
  createdBy: "user",
  creationSource: "mobile",
  text: "Continue",
  attachments: [],
  dispatchMode: { type: "queue_after_active" },
};

it("4b: an operate client may send a follow-up and stop a run through the hub", () => {
  expect(operate(followUp)).toBeUndefined();
  expect(
    operate({
      type: "run.interrupt",
      commandId: "c2",
      threadId: "t1",
      runId: "r1",
      holdQueue: true,
    }),
  ).toBeUndefined();
});

it("4b: after Stop holds the queue, Resume goes through the hub too", () => {
  // The client's stop sends holdQueue: true; without queue.resume the queue stays held.
  const stop = {
    type: "run.interrupt",
    commandId: "c-stop",
    threadId: "t1",
    runId: "r1",
    holdQueue: true,
  };
  const resume = { type: "queue.resume", commandId: "c-resume", threadId: "t1" };
  expect(operate(stop)).toBeUndefined();
  expect(operate(resume)).toBeUndefined();
  expect(admit(write, resume)).toMatchObject({ requiredScope: "orchestration:operate" });
});

it("4b: other commands stay on the node's own clients", () => {
  for (const command of [
    { type: "thread.delete", commandId: "c3", threadId: "t1" },
    { type: "thread.archive", commandId: "c4", threadId: "t1" },
    null,
  ]) {
    expect(operate(command)).toMatchObject({ requiredScope: "hub:proxy" });
  }
});

it("4b: a read-only client still cannot send a follow-up", () => {
  expect(admit(write, followUp)).toMatchObject({ requiredScope: "orchestration:operate" });
});

it("4b: an operate client may upload follow-up attachments through the hub", () => {
  const scopes = ["orchestration:read", "orchestration:operate"] as const;
  expect(
    refuseProxiedCall(scopes, "attachments.createUploadUrl", {
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 10,
    }),
  ).toBeUndefined();
  expect(
    refuseProxiedCall(["orchestration:read"], "attachments.createUploadUrl", {
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 10,
    }),
  ).toMatchObject({ requiredScope: "orchestration:operate" });
});

const full = ["orchestration:read", "orchestration:operate", "filesystem:read"] as const;

it("4c: an operate client may answer approvals, dismiss questions and start threads on a node", () => {
  for (const command of [
    {
      type: "runtime-request.respond",
      commandId: "c1",
      threadId: "t1",
      requestId: "q1",
      decision: "accept",
    },
    { type: "thread.user-input.dismiss", commandId: "c2", threadId: "t1", requestId: "q1" },
    {
      type: "thread.create",
      commandId: "c3",
      threadId: "t2",
      projectId: "p1",
      title: "New",
      modelSelection: { instanceId: "codex", model: "m" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "mobile",
    },
  ])
    expect(refuseProxiedCall(full, write, command)).toBeUndefined();
  expect(
    refuseProxiedCall(full, "orchestration.launchThread", {
      commandId: "c4",
      projectId: "p1",
      title: "Investigate",
      modelSelection: { instanceId: "codex", model: "m" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
    }),
  ).toBeUndefined();
  expect(refuseProxiedCall(full, "filesystem.browse", { partialPath: "~/" })).toBeUndefined();
});

it("4c: projects are only registered from an existing folder, without scripts", () => {
  const create = {
    type: "project.create",
    commandId: "c5",
    projectId: "p2",
    title: "repo",
    workspaceRoot: "/home/me/repo",
  };
  expect(refuseProxiedCall(full, "projects.mutate", create)).toBeUndefined();
  expect(
    refuseProxiedCall(full, "projects.mutate", { ...create, createWorkspaceRootIfMissing: true }),
  ).toMatchObject({ requiredScope: "hub:proxy" });
  // Scripts need settings:write, which never reaches a node through the hub.
  expect(refuseProxiedCall(full, "projects.mutate", { ...create, scripts: [] })).toMatchObject({
    requiredPermission: "settings:write",
  });
  expect(
    refuseProxiedCall(full, "projects.mutate", {
      type: "project.delete",
      commandId: "c6",
      projectId: "p1",
    }),
  ).toMatchObject({ requiredScope: "hub:proxy" });
});

it("4c: a read-only client cannot answer an approval", () => {
  expect(
    admit(write, {
      type: "runtime-request.respond",
      commandId: "c7",
      threadId: "t1",
      requestId: "q1",
    }),
  ).toMatchObject({ requiredScope: "orchestration:operate" });
});

const isCommand = Schema.is(OrchestrationV2Command);

const assertFollowUpFrame = (payload: unknown, admitted: boolean) => {
  const frame = JSON.stringify({ ...request("follow-up", write), payload });
  const gated = gateClientFrame(frame, (_method, input) => operate(input));
  if (admitted) expect(gated).toEqual({ forward: frame, replies: [] });
  else {
    expect(gated.forward).toBeUndefined();
    expect(gated.replies.map((reply) => JSON.parse(reply))).toMatchObject([
      {
        requestId: "follow-up",
        exit: {
          _tag: "Failure",
          cause: [
            {
              _tag: "Fail",
              error: { _tag: "EnvironmentAuthorizationError", requiredScope: "hub:proxy" },
            },
          ],
        },
      },
    ]);
  }
};

it("4b: composer model selection and a same-project source plan remain permitted follow-ups", () => {
  const payload = {
    ...followUp,
    modelSelection: { instanceId: "claude", model: "different-model" },
    sourcePlanRef: { threadId: "another-thread-in-the-project", planId: "plan-1" },
    memoryGrantCeiling: "none",
  };
  expect(isCommand(payload)).toBe(true);
  assertFollowUpFrame(payload, true);
});

it.each([
  [
    "notification",
    { notification: { source: { kind: "system" }, outcome: "updated", summary: "Update" } },
  ],
  ["scheduledTaskId", { scheduledTaskId: "task-1" }],
  ["senderThreadId", { senderThreadId: "sender-thread" }],
  [
    "delegatedCompletion",
    { delegatedCompletion: { parentRunId: "run-1", generation: 1, taskIds: ["task-1"] } },
  ],
  ["usageLimitRecoveryRequestId", { usageLimitRecoveryRequestId: "recovery-1" }],
  ["createdBy agent", { createdBy: "agent" }],
  ["dispatchMode defer_start", { dispatchMode: { type: "defer_start" } }],
  ["memoryGrantCeiling read", { memoryGrantCeiling: "read" }],
])("4b: refuses follow-up metadata %s before forwarding", (_name, extra) => {
  const payload = { ...followUp, ...extra };
  expect(isCommand(payload)).toBe(true);
  assertFollowUpFrame(payload, false);
});

const imageAttachment = (id: string | null) => ({
  type: "image",
  id,
  name: "screen.png",
  mimeType: "image/png",
  sizeBytes: 10,
});

it("4b: pending uploads and destination-thread stored attachments pass the frame gate", () => {
  const payload = {
    ...followUp,
    threadId: "Thread / Destination",
    attachments: [
      imageAttachment(createPendingAttachmentId("png")),
      imageAttachment(createAttachmentId("Thread / Destination", "png")),
    ],
  };
  expect(isCommand(payload)).toBe(true);
  assertFollowUpFrame(payload, true);
});

it.each(["alone", "mixed"])(
  "4b: refuses foreign-thread attachments %s before forwarding",
  (mode) => {
    const foreign = imageAttachment(createAttachmentId("other-thread", "png"));
    const attachments =
      mode === "alone"
        ? [foreign]
        : [
            imageAttachment(createPendingAttachmentId("png")),
            imageAttachment(createAttachmentId(followUp.threadId, "png")),
            foreign,
          ];
    const payload = { ...followUp, attachments };
    expect(isCommand(payload)).toBe(true);
    assertFollowUpFrame(payload, false);
  },
);

it("4b: refuses an attachment without a stored id before forwarding", () => {
  assertFollowUpFrame(
    {
      ...followUp,
      attachments: [{ type: "image", name: "screen.png", mimeType: "image/png", sizeBytes: 10 }],
    },
    false,
  );
});

const launchWith = (attachments: ReadonlyArray<unknown>) => ({
  commandId: "c-launch",
  threadId: "thread-new",
  projectId: "p1",
  title: "Investigate",
  modelSelection: { instanceId: "codex", model: "m" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  workspaceStrategy: { type: "root" },
  initialMessage: { text: "Look at this", attachments },
});

const answerWith = (attachments: ReadonlyArray<unknown>) => ({
  type: "runtime-request.respond",
  commandId: "c-answer",
  threadId: "thread-dest",
  requestId: "q1",
  answers: { q1: "See attached" },
  attachmentsByQuestionId: { q1: attachments },
});

it("4c: a launch carries only fresh uploads or the new thread's own files", () => {
  const launch = "orchestration.launchThread";
  expect(
    refuseProxiedCall(full, launch, {
      ...launchWith([
        imageAttachment(createPendingAttachmentId("png")),
        imageAttachment(createAttachmentId("thread-new", "png")),
      ]),
    }),
  ).toBeUndefined();
  expect(
    refuseProxiedCall(
      full,
      launch,
      launchWith([imageAttachment(createAttachmentId("other", "png"))]),
    ),
  ).toMatchObject({ requiredScope: "hub:proxy" });
  // Without a thread id the node makes a new thread, which owns nothing yet.
  const { threadId: _omit, ...fresh } = launchWith([
    imageAttachment(createAttachmentId("thread-new", "png")),
  ]);
  expect(refuseProxiedCall(full, launch, fresh)).toMatchObject({ requiredScope: "hub:proxy" });
});

it("4c: an answer to a question carries only fresh uploads or the thread's own files", () => {
  expect(
    refuseProxiedCall(
      full,
      write,
      answerWith([
        imageAttachment(createPendingAttachmentId("png")),
        imageAttachment(createAttachmentId("thread-dest", "png")),
      ]),
    ),
  ).toBeUndefined();
  for (const attachments of [
    [imageAttachment(createAttachmentId("other", "png"))],
    [
      imageAttachment(createPendingAttachmentId("png")),
      imageAttachment(createAttachmentId("other", "png")),
    ],
  ])
    expect(refuseProxiedCall(full, write, answerWith(attachments))).toMatchObject({
      requiredScope: "hub:proxy",
    });
});
