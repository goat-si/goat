import { expect, it } from "@effect/vitest";
import type { ComputerUsePrimitiveReply } from "@goat/contracts";
import { driverError } from "./DesktopDriverReplies.ts";

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
