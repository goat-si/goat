import { expect, it } from "@effect/vitest";
import type { ComputerUsePrimitiveReply } from "@goat/contracts";
import { driverError, driverResult, driverWarnings } from "./DesktopDriverReplies.ts";

type DriverJson = NonNullable<ComputerUsePrimitiveReply["result"]>;
const replyIdentity = {
  requestId: "request",
  registrationId: "registration",
  controlId: "control",
  connectionGeneration: "generation",
  runId: "run",
  turnId: "turn",
  callId: 1,
};
const launchArgs = { bundle_id: "com.apple.calculator" };
const outsideManifest =
  "launch_app bundle_id 'com.apple.calculator' is outside the capability manifest";
const manifestNote =
  "GOAT: this is outside what GOAT lets agents do with computer use on this host, not a missing macOS permission.";
const notGranted = "Accessibility access is not granted.";
const outsideBounds = "com.apple.calculator is outside this session's bounded resources.";
const failedCall = (structuredContent: DriverJson, ...texts: ReadonlyArray<string>) => ({
  ...replyIdentity,
  status: "settled" as const,
  result: {
    isError: true,
    structuredContent,
    ...(texts.length === 0 ? {} : { content: texts.map((text) => ({ type: "text", text })) }),
  },
});
const rpcError = (data: DriverJson, message: string) => ({
  ...replyIdentity,
  status: "settled" as const,
  error: { code: -32000, message, data },
});
// The driver's permission_denied_result: a refused status and a nested refusal, no effect.
const denial = (message: string) => ({
  status: "refused",
  refusal: { code: "permission_denied", message },
});
const typedDenial = {
  ...denial(outsideManifest),
  refused: "targetRefused",
  detail: "outside_manifest",
};
const codeLines = (error: ReturnType<typeof driverError>) =>
  error?.evidence?.filter((line) => line.startsWith("driver:code=")).length;
const unsupported = {
  code: "unsupported",
  effectStarted: false,
  nextStep: outsideManifest,
  evidence: ["driver:code=permission_denied"],
};

it("a JSON-RPC permission denial keeps permission_denied with the driver's words and one driver code", () => {
  const error = driverError(rpcError(denial(notGranted), notGranted), "launch_app", launchArgs);
  expect(error).toEqual({
    code: "permission_denied",
    effectStarted: false,
    nextStep: notGranted,
    evidence: ["driver:code=permission_denied"],
  });
  expect(codeLines(error)).toBe(1);
});

it("the driver's own manifest denial, typed by the proxy, stays unsupported", () => {
  expect(
    driverError(failedCall(typedDenial, outsideManifest, manifestNote), "launch_app", launchArgs),
  ).toEqual({ ...unsupported, refused: "targetRefused", detail: "outside_manifest" });
});

it("a manifest denial carried in a JSON-RPC error stays unsupported", () => {
  const error = driverError(rpcError(typedDenial, outsideManifest), "launch_app", launchArgs);
  expect(error).toEqual({ ...unsupported, refused: "targetRefused", detail: "outside_manifest" });
  expect(codeLines(error)).toBe(1);
});

it("a driver manifest denial with a refused effect stays unsupported", () => {
  const fields = { refused: "targetRefused", detail: "outside_manifest" };
  expect(
    driverError(
      failedCall({ effect: "refused", code: "permission_denied", ...fields }, outsideManifest),
      "launch_app",
      launchArgs,
    ),
  ).toEqual({
    ...unsupported,
    evidence: ["driver:effect=refused", "driver:code=permission_denied"],
    ...fields,
  });
});

it("an untyped permission_denied that names the capability manifest is a manifest denial, not a permission to ask for", () => {
  for (const reply of [
    failedCall(denial(outsideManifest), outsideManifest),
    rpcError(denial(outsideManifest), outsideManifest),
  ])
    expect(driverError(reply, "launch_app", launchArgs)).toEqual(unsupported);
});

it("the driver's bounded-resource manifest denial is unsupported with its words", () => {
  const refusal = { code: "bounded_resource_outside_manifest", message: outsideBounds };
  for (const structured of [{ status: "refused", refusal }, { refusal }])
    expect(driverError(failedCall(structured, outsideBounds), "launch_app", launchArgs)).toEqual({
      code: "unsupported",
      effectStarted: false,
      nextStep: outsideBounds,
      evidence: ["driver:code=bounded_resource_outside_manifest"],
    });
});

it("a tool result's structured content wins over error data, even when empty", () => {
  expect(
    driverError(
      {
        ...replyIdentity,
        status: "settled",
        result: { isError: true, structuredContent: {} },
        error: { code: -32000, data: { code: "permission_denied" } },
      },
      "launch_app",
      launchArgs,
    ),
  ).toEqual({
    code: "downstream_failure",
    effectStarted: false,
    nextStep: "Observe the desktop and try again.",
  });
});

it("maps expanded pre-dispatch refusal codes accurately instead of permission_denied", () => {
  const cases: ReadonlyArray<{
    readonly code: string;
    readonly expectedCode: string;
    readonly expectedRefused: string;
  }> = [
    { code: "secure_input_active", expectedCode: "private", expectedRefused: "privateMode" },
    { code: "secure_field", expectedCode: "private", expectedRefused: "privateMode" },
    {
      code: "titlebar_would_raise_window",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "sheet_or_modal_on_target_window",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "foreign_overlay_above_granted",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "hit_test_foreign_pid",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "focused_window_mismatch",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "focused_element_foreign_pid",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "focused_element_not_at_point",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "mouse_containment_unverifiable",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "keyboard_containment_unverifiable",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "off_space_containment_unverifiable",
      expectedCode: "unsupported",
      expectedRefused: "backgroundUnavailable",
    },
    {
      code: "user_actively_typing",
      expectedCode: "user_interacting",
      expectedRefused: "targetRefused",
    },
    {
      code: "recent_hid_keydown_would_misdirect",
      expectedCode: "user_interacting",
      expectedRefused: "targetRefused",
    },
    {
      code: "identity_not_unique",
      expectedCode: "stale_reference",
      expectedRefused: "staleElement",
    },
    {
      code: "identity_unproven",
      expectedCode: "stale_reference",
      expectedRefused: "staleElement",
    },
    {
      code: "ambiguous_target",
      expectedCode: "stale_reference",
      expectedRefused: "staleElement",
    },
    {
      code: "lock_timeout",
      expectedCode: "unavailable",
      expectedRefused: "helperUnavailable",
    },
  ];
  for (const entry of cases) {
    for (const structured of [{ effect: "refused", code: entry.code }, { code: entry.code }]) {
      const error = driverError(failedCall(structured), "click", { x: 1, y: 2 });
      expect(error).toMatchObject({
        code: entry.expectedCode,
        effectStarted: false,
        refused: entry.expectedRefused,
      });
      expect(error?.code).not.toBe("permission_denied");
    }
  }
});

it("surfaces focus_confirmed false as a warning and never promotes the reply to confirmed", () => {
  const reply: ComputerUsePrimitiveReply = {
    ...replyIdentity,
    status: "settled",
    result: {
      isError: false,
      structuredContent: { effect: "confirmed", focus_confirmed: false },
    },
  };
  const result = driverResult("click", reply);
  expect(result.category).toBe("unverifiable");
  expect(result.warnings).toContain(
    "target focus was not confirmed after input; verify focus before typing",
  );
  expect(result.evidence).toContain("driver:focus_confirmed=false");
  expect(result.evidence).not.toContain("driver:effect=confirmed");
  expect(result.safety).toMatchObject({
    possibleCommit: true,
    writeStatus: "may_have_applied",
    code: "write_indeterminate",
  });
  expect(driverWarnings(reply, "read")).toEqual([]);
});
