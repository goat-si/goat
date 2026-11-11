import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@goat/contracts";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { decisionInbox } from "../../state/threads";
import { HumanHandoffCard } from "./HumanHandoffCard";
import { ThreadGuestShareBar } from "./ThreadGuestShareBar";

/**
 * Every open approval of the thread above the composer until a person answers it. Past one they
 * collapse to a count that expands, so the composer stays in reach.
 */
function OpenApprovalsDock(props: { readonly threadRef: ScopedThreadRef }) {
  const handoffs = useAtomValue(decisionInbox.openApprovalsAtom(props.threadRef));
  const [expanded, setExpanded] = useState(false);
  if (handoffs.length === 0) return null;
  const cards = handoffs.map((handoff) => (
    <HumanHandoffCard
      key={handoff.handoffId}
      environmentId={props.threadRef.environmentId}
      handoff={handoff}
      inherited={false}
    />
  ));
  if (handoffs.length === 1) return <View className="shrink-0 px-4 pb-3">{cards}</View>;
  return (
    <View className="shrink-0 gap-3 px-4 pb-3">
      <View className="flex-row items-center justify-between gap-3 rounded-[20px] border border-border bg-card-alt px-4 py-3">
        <Text accessibilityRole="header" className="font-goat-bold text-base text-foreground">
          {handoffs.length} approvals need you
        </Text>
        <Button
          label={expanded ? "Hide" : "Show"}
          tone="secondary"
          onPress={() => setExpanded((value) => !value)}
        />
      </View>
      {expanded ? cards : null}
    </View>
  );
}

/** What waits on the person in this thread: its open approvals, then its guest share. */
export function ComposerThreadBars(props: {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOperateThread: boolean;
}) {
  return (
    <>
      {props.threadRef === null ? null : <OpenApprovalsDock threadRef={props.threadRef} />}
      <ThreadGuestShareBar threadRef={props.threadRef} canOperateThread={props.canOperateThread} />
    </>
  );
}
