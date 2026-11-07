import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import { EnvironmentId, ProjectId, type PullRequestActor } from "@goat/contracts";
import {
  detectPullRequestMention,
  insertPullRequestMention,
  narrowPullRequestMentions,
} from "@goat/shared/pullRequestComposerTrigger";
import { useState } from "react";
import type { TextInputSelectionChangeEvent } from "react-native";

import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { useDebouncedValue } from "../../state/queries";

const MENTION_SUGGESTION_LIMIT = 6;

/** Completes `@login` in a pull request text input from the repository's users. */
export function usePullRequestMentions(input: {
  readonly environmentId: string;
  readonly projectId: string;
  readonly repository: string;
  readonly host?: string | undefined;
  readonly changeRequestUrl?: string | undefined;
  readonly value: string;
  readonly onChangeValue: (value: string) => void;
  /** The pull request's host completes mentions (`capabilities.mentions`), and the field takes them. */
  readonly enabled: boolean;
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
    !input.enabled || host === undefined || selection === null || selection.start !== selection.end
      ? null
      : detectPullRequestMention(input.value, selection.start);
  const typed = trigger?.query ?? "";
  const search = typed === "" ? undefined : typed.slice(0, 100);
  const sent = useDebouncedValue(search, 250);
  const hosted = useEnvironmentQuery(
    trigger === null
      ? null
      : composerPullRequests.filterOptions({
          environmentId: EnvironmentId.make(input.environmentId),
          input: {
            kind: "authors",
            projectId: ProjectId.make(input.projectId),
            repository: input.repository,
            includeUpstream: true,
            ...(host === undefined ? {} : { host }),
            ...(sent ? { query: sent } : {}),
          },
        }),
  );
  // Older answers stay useful while the debounced search catches up, narrowed to what is typed now.
  const candidates = narrowPullRequestMentions(
    hosted.data?.authors ?? [],
    typed,
    MENTION_SUGGESTION_LIMIT,
  );

  return {
    open: trigger !== null,
    candidates,
    isLoading: hosted.isPending || sent !== search,
    failed: hosted.error !== null,
    selection: placed ?? undefined,
    onSelectionChange: (event: TextInputSelectionChangeEvent) => {
      setSelection(event.nativeEvent.selection);
      setPlaced(null);
    },
    onBlur: () => setSelection(null),
    select: (actor: PullRequestActor) => {
      if (trigger === null) return;
      const next = insertPullRequestMention(input.value, trigger, actor.login);
      input.onChangeValue(next.text);
      setSelection({ start: next.cursor, end: next.cursor });
      setPlaced({ start: next.cursor, end: next.cursor });
    },
  };
}
