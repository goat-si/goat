import { isAtomCommandInterrupted } from "@goat/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  markPriorityRead,
  resolveThreadPriorityRank,
  selectPriorityClear,
  selectPriorityMarkReadTargets,
  withFoldedUnseen,
  type ThreadPriorityReadPlan,
} from "@goat/client-runtime/state/thread-list-priority";
import { AuthOrchestrationOperateScope } from "@goat/contracts";
import type { MenuAction } from "@react-native-menu/menu";
import { memo, useMemo } from "react";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import { readEnvironmentScope, useEnvironmentsWithScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ThreadListV2Section } from "./thread-list-v2-items";
import type { ThreadListV2PriorityHeaderListItem } from "./threadListV2";

type Plan = ThreadPriorityReadPlan<EnvironmentThreadShell>;

const keyOf = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;
// Mobile keeps no visit watermark of its own; the server's lastVisitedAt is the read state.
const NO_LOCAL_VISITS: Readonly<Record<string, string | undefined>> = {};
const NO_ATTENTION: ReadonlyMap<string, unknown> = new Map();
const canOperate = (thread: EnvironmentThreadShell) =>
  readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);

/** "Priority (n)" with the web sidebar's Mark all as read and Clear read threads. */
export const ThreadListV2PriorityHeader = memo(function ThreadListV2PriorityHeader(props: {
  readonly rows: ThreadListV2PriorityHeaderListItem["rows"];
  readonly foldedUnseen: ThreadListV2PriorityHeaderListItem["foldedUnseen"];
  readonly pane?: "screen" | "sidebar";
  readonly onRelease: (keys: readonly string[]) => void;
  readonly onRestore: (key: string) => void;
}) {
  const { rows, foldedUnseen } = props;
  const threads = useMemo(() => rows.map((row) => row.thread), [rows]);
  const scoped = useMemo(
    () => [...threads, ...foldedUnseen.map((entry) => entry.thread)],
    [threads, foldedUnseen],
  );
  const operable = useEnvironmentsWithScope(scoped, AuthOrchestrationOperateScope);
  const visitThread = useAtomCommand(threadEnvironment.visit, "Mark thread as read");
  const wokeAtByKey = new Map(rows.map((row) => [keyOf(row.thread), row.wokeAt]));
  const withFolded = (plan: Plan, operate: (thread: EnvironmentThreadShell) => boolean) =>
    withFoldedUnseen(plan, {
      rows: threads,
      unseenUnder: (key) =>
        foldedUnseen.flatMap((entry) => (entry.rowKey === key ? [entry.thread] : [])),
      canOperate: operate,
      // A row in Priority only through unread work folded under it.
      liftedOnly: (row) =>
        resolveThreadPriorityRank({
          thread: row,
          wokeAt: wokeAtByKey.get(keyOf(row)) ?? null,
          hasChildAttention: false,
        }) === null,
    });
  const markAllPlan = (operate: (thread: EnvironmentThreadShell) => boolean) => {
    const targets = selectPriorityMarkReadTargets({
      threads,
      localLastVisitedAtByKey: NO_LOCAL_VISITS,
      wokeAtByKey,
      canOperate: operate,
    });
    return withFolded({ markRead: targets, releaseKeys: targets.map(keyOf) }, operate);
  };
  const clearPlan = (operate: (thread: EnvironmentThreadShell) => boolean) =>
    withFolded(
      selectPriorityClear({
        threads,
        localLastVisitedAtByKey: NO_LOCAL_VISITS,
        wokeAtByKey,
        attentionByOwnerKey: NO_ATTENTION,
        canOperate: operate,
      }),
      operate,
    );
  const isOperable = (thread: EnvironmentThreadShell) => operable.has(thread.environmentId);
  const canMarkAllRead = markAllPlan(isOperable).markRead.length > 0;
  const clearable = clearPlan(isOperable);
  const canClearRead = clearable.markRead.length > 0 || clearable.releaseKeys.length > 0;

  const run = (plan: Plan) => {
    const visitedAt = new Date().toISOString();
    void markPriorityRead({
      plan,
      release: props.onRelease,
      restore: props.onRestore,
      visit: async (thread) => {
        if (!canOperate(thread)) return "skipped";
        const result = await visitThread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, visitedAt },
        });
        return result._tag === "Failure" && !isAtomCommandInterrupted(result)
          ? "failed"
          : "visited";
      },
    });
  };
  const actions: MenuAction[] = [
    {
      id: "mark-all-read",
      title: "Mark all as read",
      image: "envelope.open",
      attributes: { disabled: !canMarkAllRead },
    },
    {
      id: "clear-read",
      title: "Clear read threads",
      image: "checkmark",
      attributes: { disabled: !canClearRead },
    },
  ];
  const sidebarPane = props.pane === "sidebar";

  return (
    <ThreadListV2Section
      label={`Priority (${rows.length})`}
      pane={props.pane}
      trailing={
        <Menu
          actions={actions}
          isAnchoredToRight
          title="Priority"
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "mark-all-read" && canMarkAllRead)
              run(markAllPlan(canOperate));
            if (nativeEvent.event === "clear-read" && canClearRead) run(clearPlan(canOperate));
          }}
        >
          <Pressable
            accessibilityLabel="Priority actions"
            accessibilityRole="button"
            className="-my-2.5 -mr-2 p-2"
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <SymbolView
              name="ellipsis"
              size={13}
              tintColorClassName={
                sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
              }
              type="monochrome"
            />
          </Pressable>
        </Menu>
      }
    />
  );
});
