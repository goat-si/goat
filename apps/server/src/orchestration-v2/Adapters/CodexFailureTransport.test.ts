import { assert, it } from "@effect/vitest";
import { codexTerminalFailure, recoverCodexTransportFailure } from "./CodexFailureClass.ts";

it("classifies explicit connection loss while preserving HTTP refusals and limits", () => {
  assert.equal(
    codexTerminalFailure(
      "responseStreamDisconnected",
      { responseStreamDisconnected: { httpStatusCode: null } },
      "lost",
    ).class,
    "transport_error",
  );
  assert.equal(
    codexTerminalFailure(
      "httpConnectionFailed",
      { httpConnectionFailed: { httpStatusCode: 403 } },
      "denied",
    ).class,
    "permission_error",
  );
  assert.equal(
    codexTerminalFailure(
      "responseTooManyFailedAttempts",
      { responseTooManyFailedAttempts: { httpStatusCode: 429 } },
      "limited",
    ).class,
    "usage_limit",
  );
});

it("requires matching transport evidence before upgrading a generic failure", () => {
  const failure = {
    class: "provider_error",
    code: "other",
    message: "lost",
    retryable: null,
  } as const;
  const evidence = {
    nativeMessage: "lost",
    nativeCode: "responseStreamDisconnected",
    failure: { ...failure, class: "transport_error" as const },
  };
  assert.equal(
    recoverCodexTransportFailure(failure, "other", "lost", evidence).class,
    "transport_error",
  );
  assert.equal(
    recoverCodexTransportFailure(failure, "other", "different", evidence).class,
    "provider_error",
  );
  assert.equal(
    recoverCodexTransportFailure(
      { ...failure, class: "permission_error" },
      "other",
      "lost",
      evidence,
    ).class,
    "permission_error",
  );
  const refusal = {
    nativeMessage: "403 Forbidden",
    nativeCode: "other",
    failure: { ...failure, class: "permission_error" as const },
  };
  assert.equal(
    recoverCodexTransportFailure(failure, "other", "lost", refusal, evidence).class,
    "provider_error",
  );
});
