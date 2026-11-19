import { DeviceError, DeviceHostUnavailableError } from "@goat/contracts";
import { SshCommandError } from "@goat/ssh/errors";
import { expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { DeviceHostError } from "./DeviceHost.ts";
import { sshProbeFailureMessage } from "./DeviceHostDiagnostics.ts";
import { isSshProbeFailure, SshWindowsHostError } from "./SshDeviceHost.ts";

const encodeDeviceError = Schema.encodeSync(Schema.fromJsonString(DeviceError));

it("explains unsupported Windows hosts without exposing SSH diagnostics over the wire", () => {
  const cause = new SshCommandError({
    message: "private",
    command: ["private"],
    exitCode: 9009,
    stderr: "private SSH diagnostics",
  });
  const failure = new DeviceHostError({
    hostId: "windows",
    step: "probe",
    cause: new SshWindowsHostError({ cause }),
  });
  const error = new DeviceHostUnavailableError({
    hostId: "windows",
    hostLabel: "Windows",
    reason: sshProbeFailureMessage(failure),
    cause: failure,
  });
  const encoded = encodeDeviceError(error);
  expect(encoded).toContain("host runs Windows");
  expect(encoded).not.toContain("private SSH diagnostics");
});

it("preserves missing Node guidance and hides arbitrary SSH output", () => {
  const error = (stderr: string) =>
    new DeviceHostError({
      hostId: "host",
      step: "probe",
      cause: new SshCommandError({ message: "private", command: [], exitCode: 1, stderr }),
    });
  expect(
    sshProbeFailureMessage(error("Node is missing from the non-interactive SSH PATH")),
  ).toContain("Node is not on this host's PATH");
  expect(sshProbeFailureMessage(error("private SSH diagnostics"))).not.toContain(
    "private SSH diagnostics",
  );
});

it.each([
  ["Host key verification failed.\n", "host key"],
  ["WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!\n", "changed host key"],
  ["fixture@example.invalid: Permission denied (publickey).\n", "login failed"],
  ["ssh: Could not resolve hostname example.invalid: Name or service not known\n", "resolve"],
  ["ssh: connect to host example.invalid port 22: Connection refused\n", "reach"],
])(
  "explains recognized SSH transport failures without exposing diagnostics",
  (stderr, expected) => {
    const cause = new SshCommandError({
      message: "private",
      command: [],
      exitCode: 255,
      stderr: `${stderr}token=secret-value`,
    });
    const failure = new DeviceHostError({ hostId: "fixture", step: "probe", cause });
    expect(isSshProbeFailure(cause)).toBe(true);
    const reason = sshProbeFailureMessage(failure);
    expect(reason.toLowerCase()).toContain(expected);
    expect(reason).not.toContain("secret-value");
    expect(reason).not.toContain("example.invalid");
  },
);
