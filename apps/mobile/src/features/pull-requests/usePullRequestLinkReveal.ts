import { useNavigation } from "@react-navigation/native";
import type { LegendListRef } from "@legendapp/list/react-native";
import { parsePullRequestAnchor, pullRequestLinkCommit } from "@goat/shared/pullRequestAnchor";
import { useEffect, useEffectEvent, useRef } from "react";
import { type PullRequestSection } from "./pullRequestLinkNavigation";
import type { PullRequestParams } from "./usePullRequestDiff";

/**
 * Follows a pull request link on its screen, also when the route is reused for another link:
 * opens the section, file or discussion it names and holds the named activity row in view until
 * the user scrolls.
 */
export function usePullRequestLinkReveal(input: {
  readonly params: PullRequestParams;
  readonly selectSection: (next: PullRequestSection) => void;
  readonly showActivityLink: (kind: "timeline" | "commits") => void;
  readonly clearActivityLink: () => void;
  readonly list: (section: PullRequestSection) => LegendListRef | null | undefined;
  readonly topInset: number;
  readonly activity: {
    readonly rows: ReadonlyArray<{ readonly key: string }>;
    readonly targetKey: string | null;
    readonly targetThread: { readonly id: string } | null;
  };
}) {
  const { params, activity } = input;
  const navigation = useNavigation();
  const followLink = useEffectEvent(() => {
    const target = parsePullRequestAnchor(params.navigationUrl);
    if (target?.kind !== "timeline" && target?.kind !== "commits") input.clearActivityLink();
    if (target?.kind === "diff" || target?.kind === "code") {
      const commit = pullRequestLinkCommit(params.navigationUrl);
      navigation.navigate("PullRequestFile", {
        ...params,
        path: "",
        ...(commit ? { commit } : {}),
      });
    } else if (target?.kind === "timeline" || target?.kind === "commits") {
      input.selectSection("activity");
      input.showActivityLink(target.kind);
    } else if (target?.kind === "checks") {
      input.selectSection("overview");
      // Checks head Overview, which a reused screen may have scrolled past.
      input.list("overview")?.scrollToOffset({ offset: -input.topInset, animated: false });
    } else if (target?.kind === "summary") {
      input.selectSection("overview");
    }
  });
  // oxlint-disable-next-line goat/react-effect-budget -- a link selects its section or diff even when the route is reused for another link
  useEffect(() => {
    followLink();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each clicked URL is a fresh navigation request
  }, [params.navigationUrl, params.navigationId]);

  const targetIndex = activity.rows.findIndex((row) => row.key === activity.targetKey);
  const openedDiscussion = useRef<string | null>(null);
  const positionedActivity = useRef<string | null>(null);
  // Rows above the target measure in after the first jump, so it is held until the user scrolls.
  const heldRow = useRef<number | null>(null);
  const positionRow = (index: number) =>
    void input.list("activity")?.scrollToIndex({
      index,
      viewPosition: 0,
      viewOffset: input.topInset + 12,
      animated: false,
    });
  const revealActivity = useEffectEvent(() => {
    const key = `${params.navigationUrl}:${params.navigationId ?? 0}`;
    if (activity.targetThread && openedDiscussion.current !== key) {
      openedDiscussion.current = key;
      navigation.navigate("PullRequestDiscussion", {
        ...params,
        discussionId: activity.targetThread.id,
      });
      return;
    }
    // Later filter or refresh changes move the row; they must not pull the user back to it.
    if (targetIndex >= 0 && positionedActivity.current !== key) {
      positionedActivity.current = key;
      // The list's first row is its header, so the target sits one index further down.
      heldRow.current = targetIndex + 1;
      positionRow(targetIndex + 1);
    }
  });
  const targetThreadId = activity.targetThread?.id;
  // oxlint-disable-next-line goat/react-effect-budget -- reveals the linked activity once its asynchronous rows arrive
  useEffect(() => {
    revealActivity();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- reruns when activity resolves the URL target, even a thread the filter hides
  }, [params.navigationUrl, params.navigationId, targetIndex, targetThreadId]);

  return {
    /** The user dragged the activity list; stop holding the linked row. */
    release: () => {
      heldRow.current = null;
    },
    /** Re-holds the linked row after the activity list's content changed size. */
    hold: () => {
      const held = heldRow.current;
      if (held === null) return;
      // A filter or refresh that moved the row ends the hold.
      if (held !== targetIndex + 1) heldRow.current = null;
      else positionRow(held);
    },
  };
}
