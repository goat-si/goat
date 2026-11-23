import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope, type ScopedThreadRef } from "@goat/contracts";
import type { ChildThreadApproval } from "@goat/client-runtime/state/thread-requests";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@goat/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { useEnvironmentScope } from "../../state/session";
import { ScrollView, View } from "react-native";
import Animated, { useAnimatedStyle, type DerivedValue } from "react-native-reanimated";
import { AppText } from "../../components/ui/AppText";
import { childThreadApprovalsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ChildApprovalContext, type WaitingWorker } from "./ChildApprovalContext";
import { PendingApprovalCard } from "./PendingApprovalCard";

function ChildApproval({ entry }: { entry: ChildThreadApproval }) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <View className="mx-3.5 my-2 gap-2">
      <AppText className="font-goat-bold text-sm text-foreground">
        Approval from {entry.title}
      </AppText>
      <PendingApprovalCard
        canOperateThread={canRespond}
        approval={entry.approval}
        respondingApprovalId={responding ? entry.approval.requestId : null}
        onRespond={async (requestId, decision) => {
          if (!canRespond || responding) return;
          setResponding(true);
          setError(null);
          const result = await respond({
            environmentId: entry.thread.environmentId,
            input: { threadId: entry.thread.threadId, requestId, decision },
          });
          if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setError(
              failure instanceof Error ? failure.message : "Failed to submit approval decision.",
            );
          }
          setResponding(false);
          return result;
        }}
      />
      {error !== null ? (
        <AppText
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          className="font-sans text-sm text-danger-foreground"
        >
          {error}
        </AppText>
      ) : null}
    </View>
  );
}

const NO_APPROVALS = Atom.make<ReadonlyArray<ChildThreadApproval>>([]);

export function ChildThreadApprovals(props: {
  readonly threadRef?: ScopedThreadRef | null;
  readonly approvals?: ReadonlyArray<ChildThreadApproval>;
  readonly workers?: ReadonlyArray<WaitingWorker>;
  readonly maxHeight?: DerivedValue<number>;
  readonly onOpenWorker?: (thread: ScopedThreadRef) => void;
}) {
  const { maxHeight, onOpenWorker } = props;
  const children = useAtomValue(
    props.threadRef ? childThreadApprovalsAtom(props.threadRef) : NO_APPROVALS,
  );
  const approvals = props.approvals ?? children;
  const heightStyle = useAnimatedStyle(() => ({
    maxHeight: maxHeight ? Math.min(320, maxHeight.value / 2) : 240,
  }));
  const workers = props.workers ?? approvals;
  if (approvals.length === 0 && (!onOpenWorker || workers.length === 0)) return null;
  return (
    <Animated.View style={heightStyle} className="overflow-hidden">
      <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled style={{ flexShrink: 1 }}>
        {onOpenWorker ? (
          <ChildApprovalContext approvals={workers} onOpenWorker={onOpenWorker} />
        ) : null}
        {approvals.map((entry) => (
          <ChildApproval
            key={JSON.stringify([
              entry.thread.environmentId,
              entry.thread.threadId,
              entry.approval.requestId,
            ])}
            entry={entry}
          />
        ))}
      </ScrollView>
    </Animated.View>
  );
}
