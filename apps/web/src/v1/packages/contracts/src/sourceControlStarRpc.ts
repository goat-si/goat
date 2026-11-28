import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";
import { EnvironmentAuthorizationError } from "./auth.ts";
import { SourceControlStarredInput } from "./sourceControl.ts";

export const SOURCE_CONTROL_STAR_METHODS = {
  sourceControlStarred: "sourceControl.starred",
  sourceControlStar: "sourceControl.star",
} as const;

// The server pins the repository, so clients cannot target arbitrary repositories.
export const WsSourceControlStarredRpc = Rpc.make(
  SOURCE_CONTROL_STAR_METHODS.sourceControlStarred,
  {
    payload: SourceControlStarredInput,
    success: Schema.NullOr(Schema.Boolean),
    error: EnvironmentAuthorizationError,
  },
);

export const WsSourceControlStarRpc = Rpc.make(SOURCE_CONTROL_STAR_METHODS.sourceControlStar, {
  payload: SourceControlStarredInput,
  success: Schema.Boolean,
  error: EnvironmentAuthorizationError,
});
