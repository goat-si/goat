import {
  workspaceClaimHolder,
  workspaceClaimHolderState,
} from "../workspace/workspaceLeaseRegistry.ts";

const HOLDER_REASON =
  /^goat-create-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-[0-9a-f-]{36}$/u;

export const worktreeCreationReason = (nonce: string) => {
  const holder = workspaceClaimHolder();
  return holder === undefined ? `goat-create-${nonce}` : `goat-create-${holder}-${nonce}`;
};

export const worktreeCreationHolder = (reason: string) => {
  const holder = HOLDER_REASON.exec(reason)?.[1];
  return holder === undefined ? "unknown" : workspaceClaimHolderState(holder);
};
