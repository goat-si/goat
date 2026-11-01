import { scopeThreadRef } from "@goat/client-runtime/environment";
import { AuthOrchestrationOperateScope } from "@goat/contracts";
import type { ComponentProps } from "react";

import { useThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { SidebarThreadRow, type SortableThreadRow } from "./SidebarThreadRow";
import { useThreadContextDragHandle } from "./useThreadContextDrag";

const NO_NODE_REF = () => {};

/**
 * A launched thread folded under its launcher: the same row as at the top level, outside the
 * sortable roster. It still drags into a composer and opens its context menu.
 */
export function SidebarNestedThreadRow(props: ComponentProps<typeof SortableThreadRow>) {
  const {
    sortableId,
    sortableDisabled: _sortableDisabled,
    contextDrag: _contextDrag,
    ...rowProps
  } = props;
  const canOperate = useEnvironmentScope(
    rowProps.thread.environmentId,
    AuthOrchestrationOperateScope,
  );
  const listeners = useThreadContextDragHandle({
    threadKey: sortableId,
    title: rowProps.thread.title,
    disabled: !canOperate || rowProps.isRenaming,
  });
  const thread =
    useThreadShell(scopeThreadRef(rowProps.thread.environmentId, rowProps.thread.id)) ??
    rowProps.thread;
  return (
    <SidebarThreadRow
      key={rowProps.variant}
      {...rowProps}
      thread={thread}
      sortable={{
        listeners,
        setNodeRef: NO_NODE_REF,
        transform: null,
        transition: undefined,
        isDragging: false,
      }}
    />
  );
}
