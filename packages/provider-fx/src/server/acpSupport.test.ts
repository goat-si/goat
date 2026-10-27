import { assert, describe, it } from "@effect/vitest";
import type * as EffectAcpSchema from "effect-acp/compat";

import { ProviderAdapterV2RuntimePolicy } from "@goat/provider-core/server/ProviderAdapter";

import { fxPermissionDisposition, fxSessionModeForPolicy } from "./acpSupport.ts";

const editRequest = {
  sessionId: "fx-session-01",
  toolCall: { toolCallId: "tool-1", kind: "edit", title: "Write notes.md" },
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Reject", kind: "reject_once" },
  ],
} satisfies EffectAcpSchema.RequestPermissionRequest;

describe("fx permission prompts", () => {
  // In Auto, fx's own review asks only about what it refused itself; GOAT
  // answering those by its Auto policy would approve exactly what fx escalated.
  it("sends every Auto prompt to the user", () => {
    assert.equal(
      fxPermissionDisposition(
        ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "auto",
          interactionMode: "default",
          cwd: "/work",
        }),
        editRequest,
      ),
      "ask",
    );
  });

  it.each(["approval-required", "auto-accept-edits", "full-access"] as const)(
    "%s uses ask mode and requires approval for writes",
    (runtimeMode) => {
      const policy = ProviderAdapterV2RuntimePolicy.make({
        runtimeMode,
        interactionMode: "default",
        cwd: "/work",
      });
      assert.equal(fxSessionModeForPolicy(policy), "ask");
      assert.equal(fxPermissionDisposition(policy, editRequest), "ask");
    },
  );

  it("keeps explicit approval and sandbox restrictions out of automatic review", () => {
    const auto = ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "auto",
      interactionMode: "default",
      cwd: "/work",
    });
    assert.equal(fxSessionModeForPolicy(auto), "auto");
    assert.equal(fxSessionModeForPolicy({ ...auto, approvalPolicy: "never" }), "ask");
    const readOnly = {
      ...auto,
      approvalPolicy: "never" as const,
      sandboxPolicy: { type: "readOnly" as const },
    };
    assert.equal(fxSessionModeForPolicy({ ...auto, sandboxPolicy: readOnly.sandboxPolicy }), "ask");
    assert.equal(fxPermissionDisposition(readOnly, editRequest), "deny");
  });
});
