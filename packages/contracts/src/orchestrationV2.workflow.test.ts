import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import {
  OrchestrationV2DomainEventJson,
  OrchestrationV2Subagent,
  OrchestrationV2SubagentJson,
} from "./orchestrationV2.ts";

const now = DateTime.makeUnsafe("2026-04-20T00:00:00.000Z");
const decodeOrchestrationV2Subagent = Schema.decodeUnknownSync(OrchestrationV2Subagent);
const encodeOrchestrationV2SubagentJson = Schema.encodeSync(OrchestrationV2SubagentJson);

describe("orchestration V2 workflow members", () => {
  it.each(["  indented prompt\n", "\n \t\n"])(
    "preserves workflow prompt and result %j in stored and wire JSON",
    (preview) => {
      const subagent = {
        ...decodeOrchestrationV2Subagent({
          id: "workflow-coordinator",
          threadId: "thread-1",
          runId: "run-1",
          parentNodeId: "node-root-1",
          origin: "provider_native",
          createdBy: "agent",
          driver: "claudeAgent",
          providerInstanceId: "claudeAgent",
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Run workflow",
          title: null,
          model: null,
          status: "running",
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        }),
        workflow: {
          phases: [],
          agents: [
            {
              index: 1,
              label: "Member",
              state: "completed" as const,
              model: "claude-opus-5[1m]",
              effort: "xhigh",
              speed: "standard",
              prompt: preview,
              result: preview,
            },
          ],
        },
      };
      const { workflow, ...coordinator } = subagent;
      const incoming = { ...encodeOrchestrationV2SubagentJson(coordinator), workflow };
      for (const codec of [
        OrchestrationV2SubagentJson,
        Schema.toCodecJson(OrchestrationV2Subagent),
      ]) {
        const encode = Schema.encodeSync(codec);
        const decode = Schema.decodeUnknownSync(codec);
        const json: unknown = JSON.parse(JSON.stringify(encode(subagent)));
        expect(json).toMatchObject({
          workflow: { agents: [{ prompt: preview, result: preview }] },
        });
        expect(decode(json).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
          model: "claude-opus-5[1m]",
          effort: "xhigh",
          speed: "standard",
        });
        expect(decode(incoming).workflow?.agents[0]).toMatchObject({
          prompt: preview,
          result: preview,
          model: "claude-opus-5[1m]",
          effort: "xhigh",
          speed: "standard",
        });
      }
    },
  );

  it("decodes a stored subagent.updated workflow recorded before member effort and speed", () => {
    const coordinator = decodeOrchestrationV2Subagent({
      id: "workflow-coordinator",
      threadId: "thread-1",
      runId: "run-1",
      parentNodeId: "node-root-1",
      origin: "provider_native",
      createdBy: "agent",
      driver: "claudeAgent",
      providerInstanceId: "claudeAgent",
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Run workflow",
      title: null,
      model: null,
      status: "running",
      result: null,
      startedAt: now,
      completedAt: null,
      updatedAt: now,
    });
    const codec = OrchestrationV2DomainEventJson;
    const stored = {
      id: "event-subagent-1",
      threadId: "thread-1",
      occurredAt: "2026-04-20T00:00:00.000Z",
      type: "subagent.updated",
      payload: {
        ...encodeOrchestrationV2SubagentJson(coordinator),
        workflow: {
          phases: [],
          agents: [{ index: 1, label: "Member", state: "running", model: "claude-opus-5[1m]" }],
        },
      },
    };

    const event = Schema.decodeUnknownSync(codec)(stored);
    if (event.type !== "subagent.updated") throw new Error("expected subagent.updated");
    const member = event.payload.workflow?.agents[0];
    expect(member).toMatchObject({ label: "Member", model: "claude-opus-5[1m]" });
    expect(member).not.toHaveProperty("effort");
    expect(member).not.toHaveProperty("speed");
    expect(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(event)))).toEqual(stored);
  });
});
