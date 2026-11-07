import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { ChannelTask, ChannelTaskReportInput } from "./index.ts";

const report = {
  taskId: "task-1",
  eventId: "event-1",
  generation: 1,
  status: "completed",
  summary: "Checked the deploy.",
};
const proposal = {
  name: "deploy-check",
  summary: "Check a deploy before Monday",
  text: "# Deploy check\n\n1. Open the pipeline.\n2. Compare the tag.",
};
const task = {
  taskId: "task-2",
  conversationId: "conv-1",
  originBindingId: "binding-1",
  originAddress: { kind: "goat", environmentId: "env-1", threadId: "thread-1" },
  originInputId: "input-1",
  requester: {
    ownerId: "owner",
    principalId: "owner",
    displayName: "Jun",
    originKind: "goat",
    runtimeModeCeiling: "approval-required",
    grantedScopes: ["orchestration:read"],
  },
  title: "Save skill deploy-check?",
  instruction: "",
  status: "received",
  version: 1,
  generation: 1,
  openQuestions: [],
  createdAt: "2026-11-07T00:00:00.000Z",
  updatedAt: "2026-11-07T00:00:00.000Z",
};
const stored = {
  ...proposal,
  sourceTaskId: "task-1",
  sourceTitle: "Check the deploy",
  requesterName: "Jun",
};

describe("channel.task_report skill proposal", () => {
  const decode = Schema.decodeUnknownExit(ChannelTaskReportInput);

  it("carries a proposal a skill file can be named after and hold", () => {
    const exit = decode({ ...report, skillProposal: proposal });
    expect(Exit.isSuccess(exit) ? exit.value.skillProposal : undefined).toEqual(proposal);
  });

  it("refuses names that are not one safe file name and text over its bounds", () => {
    for (const skillProposal of [
      { ...proposal, name: "ab" },
      { ...proposal, name: "a".repeat(49) },
      { ...proposal, name: "Deploy-Check" },
      { ...proposal, name: "-deploy" },
      { ...proposal, name: "deploy-" },
      { ...proposal, name: "../deploy" },
      { ...proposal, name: "deploy.md" },
      { ...proposal, summary: "x".repeat(201) },
      { ...proposal, summary: "one\ntwo" },
      { ...proposal, summary: "   " },
      { ...proposal, text: "x".repeat(8193) },
      { ...proposal, text: "  " },
    ])
      expect(Exit.isFailure(decode({ ...report, skillProposal }))).toBe(true);
    expect(Exit.isSuccess(decode({ ...report, skillProposal: { ...proposal, name: "a".repeat(48) } }))).toBe(true);
  });

  it("is ignored by a reader that predates it", () => {
    const { skillProposal: _report, ...oldReport } = ChannelTaskReportInput.fields;
    const { skillProposal: _task, ...oldTask } = ChannelTask.fields;
    expect(
      Schema.decodeUnknownSync(Schema.Struct(oldReport))({ ...report, skillProposal: proposal }),
    ).toEqual(report);
    expect(
      Schema.decodeUnknownSync(Schema.Struct(oldTask))({ ...task, skillProposal: stored }),
    ).not.toHaveProperty("skillProposal");
  });

  it("round-trips a proposal task", () => {
    const json = Schema.toCodecJson(ChannelTask);
    const decoded = Schema.decodeUnknownSync(json)({ ...task, skillProposal: stored });
    expect(Schema.decodeSync(json)(Schema.encodeSync(json)(decoded)).skillProposal).toEqual(stored);
  });
});
