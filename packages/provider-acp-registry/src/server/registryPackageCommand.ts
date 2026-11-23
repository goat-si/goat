import type { AcpRegistryDistribution } from "@goat/contracts";
import * as Schema from "effect/Schema";

export const PackageCommandName = Schema.String.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9._-]*$/iu),
);
const isPackageCommandName = Schema.is(PackageCommandName);

export function packageManagerFor(distribution: AcpRegistryDistribution): "npm" | "uv" | undefined {
  return distribution === "npx" ? "npm" : distribution === "uvx" ? "uv" : undefined;
}

export function packageCommandCandidates(
  agentId: string,
  packageName: string,
): ReadonlyArray<string> {
  const unscopedPackageName = packageName.split("/").pop() ?? packageName;
  return Array.from(
    new Set(
      [agentId, unscopedPackageName, unscopedPackageName.replace(/-acp$/u, "")].filter(
        isPackageCommandName,
      ),
    ),
  );
}
