import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef } from "@goat/contracts";
import { useState } from "react";
import { ScrollView, useWindowDimensions, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { decisionInbox } from "../../state/threads";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { HumanHandoffCard } from "./HumanHandoffCard";
import { ThreadGuestShareBar } from "./ThreadGuestShareBar";

/**
 * Every open approval of the thread above the composer until a person answers it. Past one they
 * collapse to a count that expands, so the composer stays in reach.
 */
function OpenApprovalsDock(props: { readonly threadRef: ScopedThreadRef }) {
  const handoffs = useAtomValue(decisionInbox.openApprovalsAtom(props.threadRef));
  const [expanded, setExpanded] = useState(false);
  // The composer stays on screen however long the cards are; the cards scroll instead.
  const maxHeight = Math.round(useWindowDimensions().height * 0.4);
  // Answers go to the thread's environment; while it is away the cards ask to reconnect.
  const feedAway = useAtomValue(decisionInbox.feedAwayAtom(props.threadRef.environmentId));
  const runtime = useRemoteEnvironmentRuntime(props.threadRef.environmentId);
  const offline = feedAway || runtime?.connectionState !== "connected";
  if (handoffs.length === 0) return null;
  const cards = handoffs.map((handoff) => (
    <HumanHandoffCard
      key={handoff.handoffId}
      environmentId={props.threadRef.environmentId}
      handoff={handoff}
      inherited={false}
      offline={offline}
    />
  ));
  const scrolling = (
    <ScrollView style={{ maxHeight }} contentContainerClassName="gap-3">
      {cards}
    </ScrollView>
  );
  if (handoffs.length === 1) return <View className="shrink-0 px-4 pb-3">{scrolling}</View>;
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
      {expanded ? scrolling : null}
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
