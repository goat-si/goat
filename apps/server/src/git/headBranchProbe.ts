import type * as SourceControlProvider from "@goat/source-control-core/server/SourceControlProvider";

export function headBranchProbe(
  provider: SourceControlProvider.SourceControlProvider["Service"],
  headSelectors: ReadonlyArray<string>,
  state: "open" | "all",
  defaultBranchHeadSelector?: string,
) {
  return (
    provider.headBranchProbe?.({ headSelectors, state, defaultBranchHeadSelector }) ?? {
      headSelectors,
      limit: state === "open" ? 1 : 20,
    }
  );
}
