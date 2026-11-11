import { useMemo } from "react";
import { buildModelOptions } from "../../lib/modelOptions";

export function useModelMentionOptions(
  config: Parameters<typeof buildModelOptions>[0],
  selection: Parameters<typeof buildModelOptions>[1],
  projectId: Parameters<typeof buildModelOptions>[3],
) {
  return useMemo(
    () => buildModelOptions(config, selection, undefined, projectId),
    [config, selection, projectId],
  );
}
