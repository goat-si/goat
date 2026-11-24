import { ProviderDriverKind, ProviderSetupError, type ProviderInstanceId } from "@goat/contracts";
import { brokenVersionDetail, type ProviderHost } from "@goat/provider-core/server/ProviderHost";
import * as Effect from "effect/Effect";

export const validateOpenCodeCompatibility = Effect.fn("OpenCode.validateCompatibility")(function* (
  host: ProviderHost["Service"],
  instanceId: ProviderInstanceId,
  version: string,
) {
  const detail = brokenVersionDetail({
    name: "OpenCode",
    version,
    advisory: yield* host.compatibility(ProviderDriverKind.make("opencode"), version),
  });
  if (detail !== undefined)
    return yield* new ProviderSetupError({ instanceId, operation: "runtime", detail });
});
