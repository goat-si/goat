import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import {
  formatThreadLink,
  percentDecodedThreadLinkId,
  resolveThreadLinkRef,
} from "@goat/shared/threadLinks";

import { useThreadRefs, useThreadShell } from "../../state/entities";
import { useThreadLinkLookup } from "../../state/threadLinkLookup";
import { ThreadContextChip } from "../ThreadContextChip";

export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
  /** The whole message, so its links share one lookup of the threads this client does not hold. */
  readonly markdown: string;
}) {
  const decodedId = percentDecodedThreadLinkId(props.threadId);
  const written = useThreadShell(scopeThreadRef(props.environmentId, props.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(props.environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const lookup = useThreadLinkLookup(props.environmentId, local === null ? props.markdown : null);
  const lookedUpId =
    local === null
      ? ([props.threadId, decodedId].find(
          (threadId) => threadId !== null && Object.hasOwn(lookup.titles, threadId),
        ) ?? null)
      : null;
  const refs = useThreadRefs(local === null && lookedUpId === null);
  const remote = useThreadShell(
    local === null && lookedUpId === null
      ? resolveThreadLinkRef(scopeThreadRef(props.environmentId, props.threadId), refs)
      : null,
  );
  const thread = local ?? remote;
  const environmentId = thread?.environmentId ?? props.environmentId;
  const threadId = thread?.id ?? lookedUpId ?? props.threadId;
  const lookedUpTitle = lookedUpId === null ? "" : (lookup.titles[lookedUpId]?.trim() ?? "");
  const title = thread?.title.trim() || lookedUpTitle || props.label;
  return (
    <ThreadContextChip
      record={{ environmentId, threadId, title: lookedUpTitle || props.label }}
      {...(thread === null && lookedUpId !== null
        ? { projectId: lookup.projectIds[lookedUpId] ?? null }
        : {})}
      copyMarkdown={formatThreadLink(threadId, title)}
    />
  );
}
