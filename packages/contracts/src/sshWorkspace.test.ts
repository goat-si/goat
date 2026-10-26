import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import {
  SshWorkspaceLaunchInput,
  SshWorkspaceLaunchResult,
  SshWorkspaceFetchBackInput,
  SshWorkspaceFetchBackResult,
  SshWorkspaceError,
  SshWorkspaceStage,
  SshWorkspaceCode,
} from "./sshWorkspace.ts";

const launch = {
  sourceProjectId: "project",
  destination: {
    connectionId: "saved",
    expectedEnvironmentId: "remote",
    target: { alias: "buildbox", hostname: "host.test", username: "runner", port: 2222 },
  },
  title: "Work",
  modelSelection: { instanceId: "codex", model: "model" },
  runtimeMode: "approval-required",
  interactionMode: "default",
  initialMessage: { text: "Implement" },
};
const fetchBack = {
  target: launch.destination.target,
  remoteWorkspaceRoot: "/home/runner/.goat/repos/repo-12345678",
  branch: "goat/ssh/12345678",
};
const launchResult = {
  operationId: "12345678",
  snapshotRef: "refs/goat/snapshots/12345678",
  snapshotOid: "a".repeat(40),
  remoteEnvironmentId: "remote",
  remoteProjectId: "rp",
  remoteThreadId: "rt",
  remoteRepoPath: fetchBack.remoteWorkspaceRoot,
  branch: fetchBack.branch,
};
const fetchResult = {
  sourceProjectId: "project",
  localWorkspaceRoot: "/repo",
  localRef: "refs/remotes/goat-ssh/buildbox/goat/ssh/12345678",
  commitOid: "a".repeat(40),
  remoteBranch: fetchBack.branch,
};

describe("SSH workspace schemas", () => {
  it("round trips launch and fetchBack through JSON schemas", () => {
    for (const [schema, value] of [
      [SshWorkspaceLaunchInput, launch],
      [SshWorkspaceLaunchInput, { ...launch, sourceThreadId: "thread" }],
      [SshWorkspaceLaunchResult, launchResult],
      [SshWorkspaceFetchBackInput, fetchBack],
      [SshWorkspaceFetchBackResult, fetchResult],
    ] as const) {
      const codec = Schema.toCodecJson(schema);
      const decoded = Schema.decodeUnknownSync(codec)(JSON.parse(JSON.stringify(value)));
      expect(JSON.parse(JSON.stringify(Schema.encodeSync(codec)(decoded)))).toEqual(value);
    }
    expect(
      Schema.decodeUnknownSync(SshWorkspaceLaunchInput)({
        ...launch,
        destination: {
          ...launch.destination,
          target: { ...launch.destination.target, username: null, port: null },
        },
      }).destination.target.port,
    ).toBeNull();
    for (const stage of SshWorkspaceStage.literals)
      for (const code of SshWorkspaceCode.literals) {
        const codec = Schema.toCodecJson(SshWorkspaceError);
        expect(
          Schema.decodeSync(codec)(Schema.encodeSync(codec)(new SshWorkspaceError({ stage, code })))
            .code,
        ).toBe(code);
      }
  });
  it("requires source project, destination identity and user modes", () => {
    for (const key of [
      "sourceProjectId",
      "destination",
      "runtimeMode",
      "interactionMode",
      "modelSelection",
    ] as const) {
      const value = { ...launch };
      delete (value as Record<string, unknown>)[key];
      expect(Exit.isFailure(Schema.decodeUnknownExit(SshWorkspaceLaunchInput)(value))).toBe(true);
    }
    for (const value of [
      { ...launch, title: " " },
      { ...launch, sourceProjectId: "" },
      { ...launch, sourceThreadId: "" },
      { ...launch, runtimeMode: "root" },
      { ...launch, interactionMode: "unknown" },
      { ...launch, destination: { ...launch.destination, expectedEnvironmentId: "" } },
    ])
      expect(Exit.isFailure(Schema.decodeUnknownExit(SshWorkspaceLaunchInput)(value))).toBe(true);
  });
  it("does not expose operation receipts or secret overrides", () => {
    const decoded = Schema.decodeUnknownSync(SshWorkspaceLaunchInput)({
      ...launch,
      cwd: "/escape",
      operationId: "override",
      secretOverride: true,
      callerRuntimeMode: "full-access",
      scripts: [],
    });
    expect(decoded).toEqual(launch);
    expect(Object.keys(launchResult)).not.toContain("receipt");
  });
  it("round trips safe snapshot and uncertain-launch errors", () => {
    for (const error of [
      new SshWorkspaceError({
        stage: "snapshot",
        code: "secret_candidate",
        fileNames: [".env"],
        operationId: "12345678",
      }),
      new SshWorkspaceError({
        stage: "launch",
        code: "launch_uncertain",
        host: "buildbox",
        operationId: "12345678",
      }),
    ]) {
      const codec = Schema.toCodecJson(SshWorkspaceError);
      const encoded = Schema.encodeSync(codec)(error);
      expect(Schema.decodeSync(codec)(encoded)).toMatchObject({
        stage: error.stage,
        code: error.code,
        operationId: error.operationId,
      });
      expect(encoded).not.toContain("cause");
    }
  });
  it("round trips project_not_repo_root and actionable message", () => {
    const codec = Schema.toCodecJson(SshWorkspaceError);
    const decoded = Schema.decodeSync(codec)(
      Schema.encodeSync(codec)(
        new SshWorkspaceError({ stage: "validate", code: "project_not_repo_root" }),
      ),
    );
    expect(decoded.message).toContain("repository root");
  });
  it("round trips an actionable caller authorization refusal", () => {
    const codec = Schema.toCodecJson(SshWorkspaceError);
    const decoded = Schema.decodeSync(codec)(
      Schema.encodeSync(codec)(
        new SshWorkspaceError({ stage: "validate", code: "caller_not_authorized" }),
      ),
    );
    expect(decoded.code).toBe("caller_not_authorized");
    expect(decoded.message).toContain("no longer authorized");
    expect(decoded.message).toContain("active run and access modes");
  });
});
