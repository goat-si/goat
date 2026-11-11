import { useMemo } from "react";
import type { ModelSelection, ProjectId } from "@goat/contracts";
import { buildModelOptions } from "../../lib/modelOptions";

/** The composer's `@` model mentions: the catalog's options plus the providers they belong to. */
export function useModelMentionOptions(
  props: {
    readonly serverConfig: Parameters<typeof buildModelOptions>[0];
    readonly selectedThread: { readonly projectId: ProjectId | null };
  },
  selection: ModelSelection | null,
) {
  const { serverConfig } = props;
  const projectId = props.selectedThread.projectId;
  const modelOptions = useMemo(
    () => buildModelOptions(serverConfig, selection, undefined, projectId),
    [serverConfig, selection, projectId],
  );
  return { modelOptions, modelProviders: serverConfig?.providers };
}
