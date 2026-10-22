import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { OrchestratorMcpFailure } from "../orchestratorMcp.ts";
import { SecretRequestError } from "../secretRequest.ts";
import { WorktreeMcpFailure } from "../worktreeMcp.ts";
import {
  AgentSurfaceResult,
  type CallContext,
  classifyFailure,
  fromFailure,
  fromInvalidParams,
  fromToolResult,
} from "./envelope.ts";

const isResult = Schema.is(AgentSurfaceResult);
const encodeOrchestratorFailure = Schema.encodeSync(OrchestratorMcpFailure);
const encodeSecretError = Schema.encodeSync(SecretRequestError);
const encodeWorktreeFailure = Schema.encodeSync(WorktreeMcpFailure);

const read: CallContext = { effect: "read" };
const write: CallContext = { effect: "write" };
const keyedWrite: CallContext = { effect: "write", deduplicated: true };

const text = (value: unknown) => ({
  type: "text",
  text: typeof value === "string" ? value : JSON.stringify(value),
});
const errorOf = (result: AgentSurfaceResult) => {
  expect(isResult(result)).toBe(true);
  if (result.status !== "error") throw new Error(`expected error, got ${result.status}`);
  return result.error;
};
const failed = (failure: unknown, context: CallContext) =>
  errorOf(fromToolResult({ isError: true, content: [text(failure)] }, context));

const handoff = {
  handoffId: "turn-item:handoff:1",
  kind: "approval",
  title: "Turn on Cursor Cloud?",
  state: "pending",
  expiresAt: "2026-10-23T00:30:00.000Z",
  targetPath: "provider.setup",
};

describe("fromToolResult", () => {
  it("classifies an OrchestratorMcpFailure by its code and keeps the code as reason", () => {
    const cases = [
      ["capability_denied", "permission_denied"],
      ["thread_credential_required", "unauthenticated"],
      ["thread_not_found", "not_found"],
      ["thread_not_sendable", "conflict"],
      ["host_pressure", "resource_exhausted"],
      ["target_required", "invalid_request"],
      ["orchestration_error", "internal"],
    ] as const;
    for (const [code, expected] of cases)
      expect(
        failed(
          encodeOrchestratorFailure(new OrchestratorMcpFailure({ code, message: "no" })),
          read,
        ),
      ).toMatchObject({ code: expected, reason: code, message: "no" });
  });

  it("computes retryable for the call, never from the code alone", () => {
    const hostDown = encodeOrchestratorFailure(
      new OrchestratorMcpFailure({ code: "host_unavailable", message: "Gone." }),
    );
    // A routed write may have reached the remote before it stopped answering.
    expect(failed(hostDown, read).retryable).toBe(true);
    expect(failed(hostDown, write).retryable).toBe(false);
    expect(failed(hostDown, keyedWrite).retryable).toBe(true);
    // Pressure refuses before anything runs, so even an unkeyed write may wait and repeat.
    const pressure = encodeOrchestratorFailure(
      new OrchestratorMcpFailure({ code: "host_pressure", message: "Busy." }),
    );
    expect(failed(pressure, write)).toMatchObject({ code: "resource_exhausted", retryable: true });
    // A refusal is permanent for this call whatever its effect.
    const denied = encodeOrchestratorFailure(
      new OrchestratorMcpFailure({ code: "capability_denied", message: "No." }),
    );
    expect(failed(denied, read).retryable).toBe(false);
    expect(
      failed({ _tag: "SshWorkspaceError", stage: "launch", code: "launch_uncertain" }, keyedWrite),
    ).toMatchObject({
      code: "unknown_outcome",
      retryable: false,
    });
  });

  it("classifies by reason or tag through the table and leaves unknown literals internal", () => {
    expect(
      failed(encodeSecretError(new SecretRequestError({ reason: "ref_expired" })), read),
    ).toMatchObject({
      code: "expired",
      reason: "ref_expired",
    });
    expect(
      failed(
        encodeWorktreeFailure(
          new WorktreeMcpFailure({ code: "handoff_in_progress", message: "busy" }),
        ),
        write,
      ).code,
    ).toBe("conflict");
    expect(
      failed(
        {
          _tag: "McpCapabilityUnavailableError",
          capability: "pull-requests",
          environmentId: "env-1",
        },
        read,
      ),
    ).toEqual({
      code: "permission_denied",
      reason: "McpCapabilityUnavailableError",
      message: "The call failed: McpCapabilityUnavailableError.",
      retryable: false,
      details: { capability: "pull-requests", environmentId: "env-1" },
    });
    // No pattern matching: a new tag is internal until the table names it.
    expect(classifyFailure("SomethingNewTimeoutError", "SomethingNewTimeoutError")).toEqual({
      code: "internal",
    });
  });

  it("uses a computed message passed by a server that holds the original error", () => {
    expect(
      errorOf(
        fromFailure(
          {
            _tag: "McpCapabilityUnavailableError",
            message: "MCP credential does not grant the preview capability.",
          },
          read,
        ),
      ).message,
    ).toBe("MCP credential does not grant the preview capability.");
  });

  it("never classifies a plain-text failure by its wording", () => {
    const message = "MCP credential does not grant the pull-requests capability.";
    expect(failed(message, write)).toEqual({
      code: "internal",
      reason: "tool_error",
      message,
      retryable: false,
    });
    expect(failed(message, read).retryable).toBe(true);
  });

  it("classifies a wrapped failure by the domain reason it kept, not its legacy code", () => {
    const wrapped = (fields: Partial<ConstructorParameters<typeof OrchestratorMcpFailure>[0]>) =>
      encodeOrchestratorFailure(
        new OrchestratorMcpFailure({ code: "orchestration_error", message: "No.", ...fields }),
      );
    expect(failed(wrapped({ reason: "billing_required" }), write)).toEqual({
      code: "failed_precondition",
      reason: "billing_required",
      message: "No.",
      retryable: false,
    });
    // An unreachable host proves nothing ran only for a read.
    expect(failed(wrapped({ reason: "host_unavailable" }), read)).toMatchObject({
      code: "unavailable",
      retryable: true,
    });
    // A remote refusal takes the class of the remote's own code when it is a known one.
    expect(
      failed(wrapped({ reason: "remote_refused", remoteCode: "thread_not_found" }), read),
    ).toMatchObject({
      code: "not_found",
      reason: "remote_refused",
      details: { remoteCode: "thread_not_found" },
    });
    // Prose in a reason field has no row, so the code still classifies it.
    expect(
      failed({ _tag: "ServerSettingsError", code: "thread_busy", reason: "Busy." }, read),
    ).toMatchObject({ code: "conflict", reason: "thread_busy" });
  });

  it("returns unknown_outcome for a failure after a write may have started", () => {
    const uncertain = encodeOrchestratorFailure(
      new OrchestratorMcpFailure({
        code: "orchestration_error",
        message: "Calling goat_thread_launch on box failed.",
        reason: "ssh_failed",
        mayHaveStarted: true,
      }),
    );
    expect(failed(uncertain, keyedWrite)).toEqual({
      code: "unknown_outcome",
      reason: "ssh_failed",
      message: "Calling goat_thread_launch on box failed.",
      retryable: false,
      details: { mayHaveStarted: true },
    });
  });

  it("reads image-tool failures from structured content", () => {
    const result = fromToolResult(
      {
        isError: true,
        structuredContent: {
          error: {
            _tag: "PreviewAutomationTabNotFoundError",
            operation: "snapshot",
            failureCount: 1,
          },
        },
        content: [text("No tab.")],
      },
      read,
    );
    expect(errorOf(result)).toMatchObject({
      code: "not_found",
      reason: "PreviewAutomationTabNotFoundError",
      details: { operation: "snapshot", failureCount: 1 },
    });
    // A refusal keeps its code there, so a missing thread credential is not a device failure.
    const refused = fromToolResult(
      {
        isError: true,
        structuredContent: {
          error: {
            _tag: "OrchestratorMcpFailure",
            operation: "screenshot",
            failureCount: 1,
            code: "thread_credential_required",
            message: "This tool acts as the calling GOAT thread.",
          },
        },
        content: [text("This tool acts as the calling GOAT thread.")],
      },
      read,
    );
    expect(errorOf(refused)).toMatchObject({
      code: "unauthenticated",
      reason: "thread_credential_required",
      message: "This tool acts as the calling GOAT thread.",
    });
  });

  it("turns refusals inside successful values into errors", () => {
    expect(
      errorOf(
        fromToolResult(
          {
            structuredContent: { kind: "error", code: "host_unreachable", message: "Down." },
            content: [],
          },
          write,
        ),
      ),
    ).toEqual({
      code: "unavailable",
      reason: "host_unreachable",
      message: "Down.",
      retryable: false,
    });
    expect(
      errorOf(
        fromToolResult(
          {
            structuredContent: { status: "refused", reason: "no_capacity", message: "Full." },
            content: [],
          },
          write,
        ),
      ),
    ).toMatchObject({ code: "resource_exhausted", reason: "no_capacity", retryable: true });
    expect(
      errorOf(
        fromToolResult(
          {
            structuredContent: {
              kind: "refused",
              reason: "held",
              message: "Held.",
              holderThreadId: "t",
            },
            content: [],
          },
          write,
        ),
      ),
    ).toMatchObject({ code: "conflict", reason: "held", details: { holderThreadId: "t" } });
  });

  it("returns needs_human with the handoff and the next step as a registry path", () => {
    const pathOf = (name: string) =>
      name === "goat_provider_addable_list" ? "provider.addable_list" : undefined;
    expect(
      fromToolResult(
        {
          structuredContent: {
            kind: "needs_human",
            handoff,
            next: { after: "approval", call: "goat_provider_addable_list" },
          },
          content: [],
        },
        { effect: "write", pathOf },
      ),
    ).toEqual({
      status: "needs_human",
      handoff,
      next: { after: "approval", path: "provider.addable_list" },
    });
    expect(
      fromToolResult(
        { structuredContent: { outcome: "needs_human", handoff }, content: [] },
        write,
      ),
    ).toEqual({ status: "needs_human", handoff });
  });

  it("keeps a needs_human-looking value without a valid handoff as ok", () => {
    const value = { kind: "needs_human", handoff: { handoffId: "x" } };
    expect(fromToolResult({ structuredContent: value, content: [] }, read)).toEqual({
      status: "ok",
      value,
    });
  });

  it("returns ok values, leaving domain states inside them alone", () => {
    const value = { removed: [{ path: "/w", status: "failed", reason: "dirty" }] };
    expect(fromToolResult({ structuredContent: value, content: [text(value)] }, write)).toEqual({
      status: "ok",
      value,
    });
    expect(fromToolResult({ content: [text({ threads: [] })] }, read)).toEqual({
      status: "ok",
      value: { threads: [] },
    });
  });

  it("keeps image blocks beside the value", () => {
    const image = { type: "image", data: "iVBOR", mimeType: "image/png" };
    expect(
      fromToolResult(
        { structuredContent: { width: 10 }, content: [text({ width: 10 }), image] },
        read,
      ),
    ).toEqual({ status: "ok", value: { width: 10 }, meta: { content: [image] } });
  });

  it("refuses invalid parameters as invalid_request", () => {
    expect(errorOf(fromInvalidParams("Missing key threadId"))).toEqual({
      code: "invalid_request",
      reason: "invalid_params",
      message: "Missing key threadId",
      retryable: false,
    });
  });
});
