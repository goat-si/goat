import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@goat/contracts";
import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@goat/client-runtime/state/thread-requests";
import { useState } from "react";
import { Pressable, ScrollView, View, type StyleProp, type ViewStyle } from "react-native";
import Animated, { type AnimatedStyle } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { PendingApproval } from "../../lib/threadActivity";

export interface PendingApprovalCardProps {
  readonly canOperateThread: boolean;
  readonly approval: PendingApproval;
  readonly respondingApprovalId: RuntimeRequestId | null;
  /** Caps the card; the request text scrolls while the actions stay in view. */
  readonly maxHeightStyle?: StyleProp<AnimatedStyle<StyleProp<ViewStyle>>>;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

const DEFAULT_APPROVAL_OPTIONS: ReadonlyArray<ProviderApprovalOption> = [
  { decision: "accept", label: "Allow once" },
  { decision: "acceptForSession", label: "Allow session" },
  { decision: "decline", label: "Decline" },
];

const APPROVAL_TITLE: Record<ProviderRequestKind, string> = {
  command: "Run a command",
  "file-read": "Read a file",
  "file-change": "Change files",
  "mcp-elicitation": "App access",
  permission: "App permission",
};

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  return (
    <Animated.View
      className="gap-3 overflow-hidden rounded-[20px] border border-border bg-card-alt p-4"
      style={props.maxHeightStyle}
    >
      <View className="flex-row items-center gap-1.5">
        <SymbolView
          name="exclamationmark.shield"
          size={13}
          tintColorClassName="accent-warning-foreground"
          type="monochrome"
        />
        <Text
          accessibilityRole="header"
          className="font-goat-medium text-xs text-warning-foreground"
        >
          Approval needed
        </Text>
      </View>
      <Text className="font-goat-bold text-lg text-foreground">
        {props.approval.appName ?? APPROVAL_TITLE[props.approval.requestKind]}
      </Text>
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-3"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        style={{ flexShrink: 1 }}
      >
        {props.approval.detail ? (
          <Text selectable className="font-sans text-sm leading-normal text-foreground-secondary">
            {props.approval.detail}
          </Text>
        ) : null}
        {props.approval.reason ? (
          <Text className="font-sans text-xs leading-normal text-warning-foreground">
            {props.approval.reason}
          </Text>
        ) : null}
        {props.approval.fullAccessOverride ? (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: explanationOpen }}
            onPress={() => setExplanationOpen((open) => !open)}
          >
            <Text className="font-goat-bold text-xs text-foreground-secondary underline">
              {FULL_ACCESS_OVERRIDE_QUESTION}
            </Text>
            {explanationOpen ? (
              <Text className="mt-1 font-sans text-xs leading-normal text-foreground-muted">
                {fullAccessOverrideExplanation(props.approval.fullAccessOverride)}
              </Text>
            ) : null}
          </Pressable>
        ) : null}
        {!canRespond ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            The provider process for this request is no longer available. Interrupt or restart the
            run to continue.
          </Text>
        ) : null}
        {warning ? (
          <Text className="font-sans text-xs leading-normal text-warning-foreground">
            {warning}
          </Text>
        ) : null}
      </ScrollView>
      <View className="flex-row flex-wrap gap-2">
        {options.map((option) => (
          <Button
            key={option.decision}
            label={option.label}
            tone={
              option.decision === "accept"
                ? "primary"
                : option.decision === "decline"
                  ? "danger"
                  : "secondary"
            }
            disabled={disabled || !props.canOperateThread}
            onPress={() => void props.onRespond(props.approval.requestId, option.decision)}
          />
        ))}
      </View>
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-muted">
          This connection cannot respond to approvals.
        </Text>
      ) : null}
    </Animated.View>
  );
}
