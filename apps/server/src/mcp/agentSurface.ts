import type { AgentSurfaceEntry } from "@goat/contracts/agentSurface";
import * as Context from "effect/Context";
import { Tool } from "effect/ai";

/** Registration replaces effect hints with the handler's access declaration. */
export const agentSurfaceAnnotations = (entry: AgentSurfaceEntry) => {
  const annotations = Context.make(Tool.Readonly, entry.effect === "read").pipe(
    Context.add(Tool.Destructive, entry.effect === "destructive"),
    Context.add(Tool.Idempotent, entry.annotations.idempotentHint),
    Context.add(Tool.OpenWorld, entry.annotations.openWorldHint),
  );
  return entry.annotations.title === undefined
    ? annotations
    : Context.add(annotations, Tool.Title, entry.annotations.title);
};
