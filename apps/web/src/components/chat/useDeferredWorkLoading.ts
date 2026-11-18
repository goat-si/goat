import { parseScopedThreadKey } from "@goat/client-runtime/environment";
import { use, useEffect, useEffectEvent, useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { TimelineRowCtx } from "./timelineRowContext";

export function useDeferredWorkLoading(
  row: { expanded: boolean; deferredWorkItemIds?: ReadonlyArray<string> },
  onToggle: () => void,
) {
  const ctx = use(TimelineRowCtx);
  const loadWork = useAtomCommand(threadEnvironment.loadEarlierHistory, { reportFailure: false });
  const ref = parseScopedThreadKey(ctx.routeThreadKey);
  const environmentId = ref?.environmentId;
  const threadId = ref?.threadId;
  const anchorsKey = row.deferredWorkItemIds?.join("\n") ?? "";
  const [failed, setFailed] = useState(false);
  const load = () => {
    if (!anchorsKey || environmentId === undefined || threadId === undefined) return;
    void Promise.all(
      anchorsKey
        .split("\n")
        .map((workAnchorId) => loadWork({ environmentId, input: { threadId, workAnchorId } })),
    ).then((results) =>
      setFailed(
        results.some((result) => result._tag === "Failure" || result.value._tag === "error"),
      ),
    );
  };
  const loadOnExpand = useEffectEvent(load);
  // oxlint-disable-next-line goat/react-effect-budget -- Restored expanded folds load their deferred server history on mount.
  useEffect(() => {
    if (row.expanded && anchorsKey && environmentId && threadId) loadOnExpand();
  }, [row.expanded, anchorsKey, environmentId, threadId]);
  const error = anchorsKey && failed ? "Couldn't load work. Click to retry." : null;
  const loading = ref !== null && row.expanded && anchorsKey !== "" && !failed;
  const toggle = () => {
    setFailed(false);
    if (error && row.expanded) load();
    else onToggle();
  };

  return { loading, error, toggle };
}
