import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import * as Memory from "./memory.ts";

export const MEMORY_WS_METHODS = {
  memoryProjectBindingGet: "memory.projectBinding.get",
  memoryProjectBindingUpdate: "memory.projectBinding.update",
  memoryChanges: "memory.changes",
  memorySearch: "memory.search",
  memoryList: "memory.list",
  memoryRead: "memory.read",
  memoryHistory: "memory.history",
  memoryHubDiagnostics: "memory.hub.diagnostics",
  memoryHubReconcile: "memory.hub.reconcile",
  memoryResetReportAttempts: "memory.resetReportAttempts",
  memorySyncStatus: "memory.syncStatus",
  memoryOwnerSourceReadPolicyGet: "memory.ownerSourceReadPolicy.get",
  memoryOwnerSourceReadPolicyUpdate: "memory.ownerSourceReadPolicy.update",
  memoryUpsert: "memory.upsert",
  memoryForget: "memory.forget",
  memoryRevertResolution: "memory.revertResolution",
  memoryReadSource: "memory.readSource",
  memoryHubSettingsGet: "memory.hubSettings.get",
  memoryHubSettingsUpdate: "memory.hubSettings.update",
  memoryImportProvider: "memory.importProvider",
} as const;

const MemoryRpcErrors = Schema.Union([Memory.MemoryRpcError, EnvironmentAuthorizationError]);
const MemoryImportRpcErrors = Schema.Union([
  Memory.MemoryRpcError,
  Memory.MemoryImportRpcError,
  EnvironmentAuthorizationError,
]);
export const WsMemoryProjectBindingGetRpc = Rpc.make(MEMORY_WS_METHODS.memoryProjectBindingGet, {
  payload: Memory.MemoryProjectBindingGetInput,
  success: Memory.MemoryProjectBinding,
  error: MemoryRpcErrors,
});
export const WsMemoryProjectBindingUpdateRpc = Rpc.make(
  MEMORY_WS_METHODS.memoryProjectBindingUpdate,
  {
    payload: Memory.MemoryProjectBindingUpdateInput,
    success: Memory.MemoryProjectBindingUpdateResult,
    error: MemoryRpcErrors,
  },
);
export const WsMemoryChangesRpc = Rpc.make(MEMORY_WS_METHODS.memoryChanges, {
  payload: Memory.MemoryChangesInput,
  success: Memory.MemoryChangeSignal,
  error: MemoryRpcErrors,
  stream: true,
});
export const WsMemorySearchRpc = Rpc.make(MEMORY_WS_METHODS.memorySearch, {
  payload: Memory.MemorySearchInput,
  success: Memory.MemoryPage,
  error: MemoryRpcErrors,
});
export const WsMemoryListRpc = Rpc.make(MEMORY_WS_METHODS.memoryList, {
  payload: Memory.MemoryListInput,
  success: Memory.MemoryPage,
  error: MemoryRpcErrors,
});
export const WsMemoryReadRpc = Rpc.make(MEMORY_WS_METHODS.memoryRead, {
  payload: Memory.MemoryReadInput,
  success: Memory.MemoryItem,
  error: MemoryRpcErrors,
});
export const WsMemoryHistoryRpc = Rpc.make(MEMORY_WS_METHODS.memoryHistory, {
  payload: Memory.MemoryHistoryInput,
  success: Memory.MemoryHistoryPage,
  error: MemoryRpcErrors,
});
export const WsMemorySyncStatusRpc = Rpc.make(MEMORY_WS_METHODS.memorySyncStatus, {
  payload: Memory.MemorySyncStatusInput,
  success: Memory.MemorySyncStatus,
  error: MemoryRpcErrors,
});
export const WsMemoryHubDiagnosticsRpc = Rpc.make(MEMORY_WS_METHODS.memoryHubDiagnostics, {
  payload: Memory.MemorySyncStatusInput,
  success: Memory.MemoryHubDiagnostics,
  error: MemoryRpcErrors,
});
export const WsMemoryUpsertRpc = Rpc.make(MEMORY_WS_METHODS.memoryUpsert, {
  payload: Memory.MemoryUpsertInput,
  success: Memory.MemoryMutationReceipt,
  error: MemoryRpcErrors,
});
export const WsMemoryForgetRpc = Rpc.make(MEMORY_WS_METHODS.memoryForget, {
  payload: Memory.MemoryForgetInput,
  success: Memory.MemoryMutationReceipt,
  error: MemoryRpcErrors,
});
export const WsMemoryRevertResolutionRpc = Rpc.make(MEMORY_WS_METHODS.memoryRevertResolution, {
  payload: Memory.MemoryRevertResolutionInput,
  success: Memory.MemoryRevertResult,
  error: MemoryRpcErrors,
});
export const WsMemoryReadSourceRpc = Rpc.make(MEMORY_WS_METHODS.memoryReadSource, {
  payload: Memory.MemoryReadSourceInput,
  success: Memory.MemorySourcePage,
  error: MemoryRpcErrors,
});
export const WsMemoryHubSettingsGetRpc = Rpc.make(MEMORY_WS_METHODS.memoryHubSettingsGet, {
  payload: Memory.MemoryHubSettingsGetInput,
  success: Memory.MemoryHubSettingsView,
  error: MemoryRpcErrors,
});
export const WsMemoryHubSettingsUpdateRpc = Rpc.make(MEMORY_WS_METHODS.memoryHubSettingsUpdate, {
  payload: Memory.MemoryHubSettingsUpdateInput,
  success: Memory.MemoryHubSettingsUpdateResult,
  error: MemoryRpcErrors,
});
export const WsMemoryOwnerSourceReadPolicyGetRpc = Rpc.make(
  MEMORY_WS_METHODS.memoryOwnerSourceReadPolicyGet,
  {
    payload: Memory.MemoryOwnerSourceReadPolicyGetInput,
    success: Memory.MemoryOwnerSourceReadPolicyView,
    error: MemoryRpcErrors,
  },
);
export const WsMemoryOwnerSourceReadPolicyUpdateRpc = Rpc.make(
  MEMORY_WS_METHODS.memoryOwnerSourceReadPolicyUpdate,
  {
    payload: Memory.MemoryOwnerSourceReadPolicyUpdateInput,
    success: Memory.MemoryOwnerSourceReadPolicyView,
    error: MemoryRpcErrors,
  },
);
export const WsMemoryResetReportAttemptsRpc = Rpc.make(
  MEMORY_WS_METHODS.memoryResetReportAttempts,
  {
    payload: Memory.MemoryResetReportAttemptsInput,
    success: Memory.MemoryResetReportAttemptsResult,
    error: MemoryRpcErrors,
  },
);
export const WsMemoryHubReconcileRpc = Rpc.make(MEMORY_WS_METHODS.memoryHubReconcile, {
  payload: Memory.MemoryHubReconcileInput,
  success: Memory.MemoryHubReconcileResult,
  error: MemoryRpcErrors,
});
export const MemoryAdministrationRpcs = RpcGroup.make(
  WsMemoryHubReconcileRpc,
  WsMemoryResetReportAttemptsRpc,
  WsMemoryOwnerSourceReadPolicyGetRpc,
  WsMemoryOwnerSourceReadPolicyUpdateRpc,
);
export const WsMemoryImportProviderRpc = Rpc.make(MEMORY_WS_METHODS.memoryImportProvider, {
  payload: Memory.MemoryImportProviderInput,
  success: Memory.MemoryImportProviderResult,
  error: MemoryImportRpcErrors,
});
export const MemoryCoreRpcs = RpcGroup.make(
  WsMemoryProjectBindingGetRpc,
  WsMemoryProjectBindingUpdateRpc,
  WsMemoryChangesRpc,
  WsMemorySearchRpc,
  WsMemoryListRpc,
  WsMemoryReadRpc,
  WsMemoryHistoryRpc,
  WsMemorySyncStatusRpc,
  WsMemoryHubDiagnosticsRpc,
  WsMemoryUpsertRpc,
  WsMemoryForgetRpc,
  WsMemoryRevertResolutionRpc,
  WsMemoryReadSourceRpc,
  WsMemoryHubSettingsGetRpc,
  WsMemoryHubSettingsUpdateRpc,
);
export const MemoryImportRpcs = RpcGroup.make(WsMemoryImportProviderRpc);
