import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";

import { EnvironmentAuthorizationError } from "./auth.ts";
import * as Decisions from "./decisions.ts";
import { OrchestratorMcpFailure } from "./orchestratorMcpFailure.ts";

export const DECISION_WS_METHODS = {
  decisionList: "decision.list",
  decisionGet: "decision.get",
  decisionRequest: "decision.request",
  decisionAnswer: "decision.answer",
  decisionWithdraw: "decision.withdraw",
} as const;

const decisionRpcErrors = Schema.Union([OrchestratorMcpFailure, EnvironmentAuthorizationError]);
export const DecisionRpcs = RpcGroup.make(
  Rpc.make(DECISION_WS_METHODS.decisionList, {
    payload: Decisions.DecisionListInput,
    success: Decisions.DecisionListResult,
    error: decisionRpcErrors,
  }),
  Rpc.make(DECISION_WS_METHODS.decisionGet, {
    payload: Decisions.DecisionGetInput,
    success: Decisions.DecisionItem,
    error: decisionRpcErrors,
  }),
  Rpc.make(DECISION_WS_METHODS.decisionRequest, {
    payload: Decisions.DecisionRequestInput,
    success: Decisions.DecisionItem,
    error: decisionRpcErrors,
  }),
  Rpc.make(DECISION_WS_METHODS.decisionAnswer, {
    payload: Decisions.DecisionAnswerInput,
    success: Decisions.DecisionItem,
    error: decisionRpcErrors,
  }),
  Rpc.make(DECISION_WS_METHODS.decisionWithdraw, {
    payload: Decisions.DecisionWithdrawInput,
    success: Decisions.DecisionItem,
    error: decisionRpcErrors,
  }),
);
