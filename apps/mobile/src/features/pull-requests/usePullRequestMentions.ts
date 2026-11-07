import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { EnvironmentId, ProjectId } from "@goat/contracts";
import {
  debouncedPullRequestCompletionSearch,
  detectPullRequestComposerTrigger,
  insertPullRequestCompletion,
  pullRequestCompletionKey,
  pullRequestCompletions,
  type PullRequestCompletion,
  type PullRequestCompletionSupport,
} from "@goat/shared/pullRequestComposerTrigger";
import { useState } from "react";
import type { TextInputSelectionChangeEvent } from "react-native";

import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";

const COMPLETION_SUGGESTION_LIMIT = 6;

/** Completes `@login`, `#123` and GitLab `!123` in a pull request text input. */
export function usePullRequestCompletions(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly host?: string | undefined;
  readonly changeRequestUrl?: string | undefined;
  readonly value: string;
  readonly onChangeValue: (value: string) => void;
  /** What the pull request's host completes (its `capabilities`); null where the field takes none. */
  readonly support: PullRequestCompletionSupport | null;
}) {
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  // Set only right after an insertion, so the native input keeps its own caret otherwise.
  const [placed, setPlaced] = useState<{ start: number; end: number } | null>(null);
  const host =
    input.host ??
    (input.changeRequestUrl
      ? sourceControlClients.parseChangeRequestUrl(input.changeRequestUrl)?.link.host
      : undefined);
  const trigger =
    host === undefined ||
    input.support === null ||
    selection === null ||
    selection.start !== selection.end
      ? null
      : detectPullRequestComposerTrigger(input.value, selection.start, input.support);
  const key = pullRequestCompletionKey(trigger);
  const sentKey = useDebouncedValue(key, 250);
  const sent =
    trigger === null ? undefined : debouncedPullRequestCompletionSearch(trigger, sentKey);
  const hosted = useEnvironmentQuery(
    trigger === null
      ? null
      : composerPullRequests.filterOptions({
          environmentId: EnvironmentId.make(input.environmentId),
          input:
            trigger.kind === "mention"
              ? {
                  kind: "authors",
                  projectId: ProjectId.make(input.projectId),
                  repository: input.repository,
                  host,
                  includeUpstream: true,
                  ...(sent ? { query: sent } : {}),
                }
              : {
                  kind: "references",
                  projectId: ProjectId.make(input.projectId),
                  repository: input.repository,
                  host,
                  includeUpstream: true,
                  sigil: trigger.sigil,
                  ...(sent ? { query: sent } : {}),
                },
        }),
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  const candidates = pullRequestCompletions(trigger, hosted.data, COMPLETION_SUGGESTION_LIMIT);

  return {
    kind: trigger?.kind ?? null,
    candidates,
    isLoading: hosted.isPending || sentKey !== key,
    failed: hosted.error !== null,
    incomplete: hosted.data?.truncated === true,
    selection: placed ?? undefined,
    onSelectionChange: (event: TextInputSelectionChangeEvent) => {
      setSelection(event.nativeEvent.selection);
      setPlaced(null);
    },
    onBlur: () => setSelection(null),
    select: (completion: PullRequestCompletion) => {
      if (trigger === null) return;
      const next = insertPullRequestCompletion(input.value, trigger, completion.token);
      input.onChangeValue(next.text);
      setSelection({ start: next.cursor, end: next.cursor });
      setPlaced({ start: next.cursor, end: next.cursor });
    },
  };
}
