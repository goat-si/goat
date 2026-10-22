import { describe, expect, it } from "vite-plus/test";
import { clientRpcRequiredScopes, CLIENT_GUARDED_RPC_SCOPES } from "./clientRpcPermissions.ts";
import { WS_METHODS } from "./rpc.ts";
describe("memory client guards", () => {
  it("guards all three memory mutations", () => {
    for (const method of [
      WS_METHODS.memoryUpsert,
      WS_METHODS.memoryForget,
      WS_METHODS.memoryRevertResolution,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:write"]);
  });
  it("requires memory write and filesystem read for provider import", () =>
    expect(clientRpcRequiredScopes(WS_METHODS.memoryImportProvider, {})).toEqual([
      "memory:write",
      "filesystem:read",
    ]));
  it("disables cloud machine changes without settings write and leaves listing to the server", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.cloudMachinesList, {})).toEqual([]);
    for (const method of [
      WS_METHODS.cloudMachinesConfigure,
      WS_METHODS.cloudMachinesCreate,
      WS_METHODS.cloudMachinesResume,
      WS_METHODS.cloudMachinesDelete,
      WS_METHODS.cloudMachinesEnsureReady,
    ])
      expect(clientRpcRequiredScopes(method, {}), method).toEqual(["settings:write"]);
  });
  it("guards hub settings update with settings write", () => {
    for (const method of [WS_METHODS.memoryHubSettingsGet, WS_METHODS.memoryHubSettingsUpdate])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
  });
  it("lets readers list and check hub nodes but needs settings write to change them", () => {
    for (const method of [
      WS_METHODS.hubNodesList,
      WS_METHODS.hubNodesSubscribe,
      WS_METHODS.hubNodesCheck,
    ])
      expect(clientRpcRequiredScopes(method, {}), method).toEqual(["orchestration:read"]);
    for (const method of [
      WS_METHODS.hubNodesAdd,
      WS_METHODS.hubNodesRemove,
      WS_METHODS.hubNodesImport,
      WS_METHODS.hubNodesDismissNotice,
    ])
      expect(clientRpcRequiredScopes(method, {}), method).toEqual(["settings:write"]);
  });
  it("leaves existing compound guards unchanged", () => {
    expect(clientRpcRequiredScopes(WS_METHODS.sshWorkspaceLaunch, {})).toEqual([
      "source-control:write",
      "orchestration:operate",
    ]);
    expect(
      clientRpcRequiredScopes(WS_METHODS.gitPreparePullRequestThread, {
        mode: "worktree",
        cwd: "scratch",
        reference: "1",
        threadId: "t",
      }),
    ).toEqual(["source-control:write", "orchestration:operate"]);
  });
  it("requires explicit transcript permission for readSource and guards bindings", () => {
    expect(Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, WS_METHODS.memoryReadSource)).toBe(true);
    expect(clientRpcRequiredScopes(WS_METHODS.memoryReadSource, {})).toEqual([
      "memory:read",
      "orchestration:read",
    ]);
    for (const method of [
      WS_METHODS.memoryProjectBindingGet,
      WS_METHODS.memoryProjectBindingUpdate,
    ])
      expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:write"]);
  });
});
it("binding get and update require memory write", () => {
  for (const method of [WS_METHODS.memoryProjectBindingGet, WS_METHODS.memoryProjectBindingUpdate])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:write"]);
});
it("source read needs explicit thread read", () =>
  expect(clientRpcRequiredScopes(WS_METHODS.memoryReadSource, {})).toEqual([
    "memory:read",
    "orchestration:read",
  ]));
it("memory write never implies source read", () => {
  expect(clientRpcRequiredScopes(WS_METHODS.memoryUpsert, {})).not.toContain("orchestration:read");
  expect(clientRpcRequiredScopes(WS_METHODS.memoryReadSource, {})).not.toContain("memory:write");
});

it("registers every core read and owner policy administration guard", () => {
  for (const method of [
    WS_METHODS.memorySearch,
    WS_METHODS.memoryList,
    WS_METHODS.memoryRead,
    WS_METHODS.memoryHistory,
    WS_METHODS.memoryChanges,
    WS_METHODS.memorySyncStatus,
    WS_METHODS.memoryHubDiagnostics,
  ]) {
    expect(CLIENT_GUARDED_RPC_SCOPES[method]).toBe("memory:read");
    expect(clientRpcRequiredScopes(method, {})).toEqual(["memory:read"]);
  }
  for (const method of [
    WS_METHODS.memoryOwnerSourceReadPolicyGet,
    WS_METHODS.memoryOwnerSourceReadPolicyUpdate,
  ])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
});

it("human handoff and secret answers require orchestration operation permission", () => {
  for (const method of [
    WS_METHODS.handoffsOpen,
    WS_METHODS.handoffsRespond,
    WS_METHODS.secretsAnswerRequest,
  ]) {
    expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
  }
});

it("report retry reset is Settings-only", () =>
  expect(clientRpcRequiredScopes(WS_METHODS.memoryResetReportAttempts, {})).toEqual([
    "settings:write",
  ]));

it("hub reconcile requires Settings authority", () => {
  expect(clientRpcRequiredScopes(WS_METHODS.memoryHubReconcile, {})).toEqual(["settings:write"]);
});

it("SSH setup separates read, settings and runtime-maintenance authority", () => {
  for (const method of [
    WS_METHODS.sshHostProbe,
    WS_METHODS.sshHostPreflight,
    WS_METHODS.sshHostTrust,
    WS_METHODS.sshHostForget,
  ])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["settings:write"]);
  expect(clientRpcRequiredScopes(WS_METHODS.sshHostPrepare, {})).toEqual(["environment:maintain"]);
  for (const method of [WS_METHODS.sshHostStatus, WS_METHODS.sshHostHandoffProgress])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:read"]);
  expect(clientRpcRequiredScopes(WS_METHODS.handoffsRespond, {})).toEqual([
    "orchestration:operate",
  ]);
});

it("decision reads and mutations carry environment scopes", () => {
  for (const method of [WS_METHODS.decisionList, WS_METHODS.decisionGet])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:read"]);
  for (const method of [
    WS_METHODS.decisionRequest,
    WS_METHODS.decisionAnswer,
    WS_METHODS.decisionWithdraw,
  ])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
});

it("hub device verify and membership changes need orchestration:operate", () => {
  for (const method of [
    WS_METHODS.hubDeviceVerify,
    WS_METHODS.hubDeviceJoin,
    WS_METHODS.hubDeviceLeave,
    WS_METHODS.hubDeviceRepair,
  ])
    expect(clientRpcRequiredScopes(method, {})).toEqual(["orchestration:operate"]);
});
