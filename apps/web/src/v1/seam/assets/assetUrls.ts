// Seam (lane F): replaces v1 apps/web/src/assets/assetUrls.ts @916b5cc. v1 mints asset URLs from the environment's asset server. GOAT 2 serves no assets yet, so every asset reports
// Failure / null and the lifted rows draw their own fallbacks (app icon tile, no image). Planned: GOAT 2 asset route.
// Listed in docs/PROVENANCE.md (v1 bridge table).
import type { AssetResource, EnvironmentId } from "@goat/contracts";

export type AssetUrlState = (
  | { readonly _tag: "Loading" }
  | { readonly _tag: "Failure"; readonly reason?: "missing-file-access" }
  | {
      readonly _tag: "Success";
      readonly url: string;
      readonly expiresAt: number;
      readonly sourcePath?: string;
      readonly fileRevision?: string;
    }
) & { readonly waiting?: boolean };

const UNAVAILABLE: AssetUrlState = { _tag: "Failure" };

export function useAssetUrlState(
  _environmentId: EnvironmentId | null,
  _resource: AssetResource | null,
  _revision?: string | null,
): AssetUrlState {
  return UNAVAILABLE;
}

export function useAssetUrls(
  _environmentId: EnvironmentId,
  resources: ReadonlyArray<AssetResource>,
): ReadonlyArray<string | null> {
  return resources.map(() => null);
}
