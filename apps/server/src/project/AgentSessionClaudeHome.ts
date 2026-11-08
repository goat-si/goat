import { expandHomePath } from "@goat/provider-core/server/pathExpansion";
import type * as Path from "effect/Path";

export function resolveClaudeConfigDir(input: {
  readonly homePath: string;
  readonly environmentHome: string | undefined;
  readonly homeDir: string;
  readonly path: Path.Path;
}): string {
  const configured = input.homePath.trim();
  if (configured.length > 0) {
    return input.path.resolve(expandHomePath(configured, input.homeDir));
  }
  const fromEnvironment = input.environmentHome?.trim() ?? "";
  if (fromEnvironment.length > 0) {
    return input.path.resolve(expandHomePath(fromEnvironment, input.homeDir));
  }
  return input.path.join(input.homeDir, ".claude");
}
