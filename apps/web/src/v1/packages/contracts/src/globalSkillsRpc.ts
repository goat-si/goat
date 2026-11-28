import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { ServerProviderSkill } from "./server.ts";

export const GLOBAL_SKILLS_WS_METHODS = {
  globalRemove: "skills.globalRemove",
  globalRescan: "skills.globalRescan",
} as const;
export class GlobalSkillsRpcError extends Schema.TaggedError<GlobalSkillsRpcError>()(
  "GlobalSkillsRpcError",
  {
    message: Schema.String,
  },
) {}
const errors = Schema.Union([GlobalSkillsRpcError, EnvironmentAuthorizationError]);
const result = Schema.Struct({
  globalSkillsDir: Schema.String,
  skills: Schema.Array(ServerProviderSkill),
});
/** rpc.ts adds scope authorization, which lives there, when it publishes WsGlobalSkillsRpcGroup. */
export const GlobalSkillsRpcs = RpcGroup.make(
  Rpc.make(GLOBAL_SKILLS_WS_METHODS.globalRemove, {
    payload: Schema.Struct({ name: Schema.String }),
    success: result,
    error: errors,
  }),
  Rpc.make(GLOBAL_SKILLS_WS_METHODS.globalRescan, {
    payload: Schema.Struct({}),
    success: result,
    error: errors,
  }),
);
