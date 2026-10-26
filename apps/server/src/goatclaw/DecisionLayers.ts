import * as Layer from "effect/Layer";
import * as DecisionInbox from "./DecisionInbox.ts";
import * as DecisionService from "./DecisionService.ts";
import * as Profiles from "./PermissionProfiles.ts";
import * as PendingQuestions from "../mcp/PendingQuestionsMcpService.ts";
import * as HostThreads from "../mcp/HostThreadsMcpService.ts";

// The routing facade sits above the local inbox: pending projections already depend on hosts.
export const layer = DecisionService.layer.pipe(
  Layer.provideMerge(DecisionInbox.layerRunning.pipe(Layer.provideMerge(DecisionInbox.layer))),
  Layer.provideMerge(PendingQuestions.layer),
  Layer.provideMerge(HostThreads.layer),
  Layer.provide(Profiles.layer),
);
