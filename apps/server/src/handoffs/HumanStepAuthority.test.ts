import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@goat/contracts";

import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import {
  PERSON,
  canResolveHumanStep,
  mcpResolver,
  sessionResolver,
  type HumanStep,
} from "./HumanStepAuthority.ts";

const outside = (approvals: boolean, thread = false): McpInvocationScope => ({
  environmentId: EnvironmentId.make("test"),
  issuedAt: 0,
  requestNamespace: "test",
  capabilities: new Set(["orchestration"]),
  client: { sessionId: "client", label: "Bot", access: "full-access", approvals },
  thread: thread
    ? {
        threadId: ThreadId.make("thread"),
        providerSessionId: "session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      }
    : undefined,
});
const steps: ReadonlyArray<HumanStep> = ["runtime_approval", "person_only"];

describe("who may resolve a human step", () => {
  it("lets a person resolve both kinds, an approve-scoped outside client only runtime approvals, and a thread credential neither", () => {
    const allowed = (resolver: Parameters<typeof canResolveHumanStep>[0]) =>
      steps.filter((step) => canResolveHumanStep(resolver, step));
    expect(allowed(PERSON)).toEqual(steps);
    expect(allowed(mcpResolver(outside(true)))).toEqual(["runtime_approval"]);
    expect(allowed(mcpResolver(outside(false)))).toEqual([]);
    // A thread scope that also carries an approve-scoped client is still a thread.
    expect(allowed(mcpResolver(outside(true, true)))).toEqual([]);
  });

  it("treats an MCP client session as no person, and the owning desktop's bootstrap session as one", () => {
    expect(canResolveHumanStep(sessionResolver({ subject: "mcp-client" }), "person_only")).toBe(
      false,
    );
    for (const subject of ["desktop-bootstrap", "browser"])
      expect(canResolveHumanStep(sessionResolver({ subject }), "person_only")).toBe(true);
  });
});
