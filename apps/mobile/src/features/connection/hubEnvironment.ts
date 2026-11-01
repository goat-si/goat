import type { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as ConnectionStorage from "../../connection/storage";
import type { ConnectHubIntent } from "./connectHubIntent";

export { selectHubEnvironmentId } from "./connectHubIntent";

export const loadHubEnvironmentId = Effect.fn("mobile.hub.load")(function* () {
  return yield* (yield* ConnectionStorage.HubEnvironmentStore).readHub;
});

export const rememberHubEnvironment = Effect.fn("mobile.hub.remember")(function* (input: {
  readonly intent: ConnectHubIntent;
  readonly pairedEnvironmentId: EnvironmentId;
}) {
  if (input.intent === "hub" || input.intent === "change-hub") {
    yield* (yield* ConnectionStorage.HubEnvironmentStore).setHub(input.pairedEnvironmentId);
  }
});
