import { Button } from "../../components/ui/Button";
import type {
  ProviderApprovalDecision,
  ProviderApprovalOption,
  ProviderRequestKind,
  RuntimeRequestId,
} from "@goat/contracts";
import {
  type ApprovalTextPart,
  approvalTextParts,
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@goat/client-runtime/state/thread-requests";
import { type ComponentRef, useRef, useState } from "react";
import {
  type LayoutChangeEvent,
  Pressable,
  ScrollView,
  type StyleProp,
  View,
  type ViewStyle,
} from "react-native";
import Animated, { type AnimatedStyle } from "react-native-reanimated";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import type { PendingApproval } from "../../lib/threadActivity";
import { approvalActionsFitPinned } from "./approvalCardLayout";

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

type MeasuredPart = "header" | "actions" | "card";

export function PendingApprovalCard(props: PendingApprovalCardProps) {
  const options: ReadonlyArray<ProviderApprovalOption> =
    props.approval.options ?? DEFAULT_APPROVAL_OPTIONS;
  const warning = options.find((option) => option.warning)?.warning;
  const canRespond = props.approval.responseCapability === "live";
  const disabled = !canRespond || props.respondingApprovalId === props.approval.requestId;
  const [explanationOpen, setExplanationOpen] = useState(false);
  const [measured, setMeasured] = useState({ header: 0, actions: 0, card: 0 });
  const measure = (part: MeasuredPart) => (event: LayoutChangeEvent) => {
    const height = event.nativeEvent.layout.height;
    setMeasured((current) => (current[part] === height ? current : { ...current, [part]: height }));
  };
  const pinned = approvalActionsFitPinned({
    headerHeight: measured.header,
    actionsHeight: measured.actions,
    cardHeight: measured.card,
  });

  const header = (
    <View className="gap-3" onLayout={measure("header")}>
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
    </View>
  );
  const detail = props.approval.detail ? approvalTextParts(props.approval.detail) : null;
  const request = (
    <>
      {detail ? (
        detail.hiddenLength > 0 ? (
          <>
            <ApprovalTextScroll parts={detail.parts} />
            <Text className="font-sans text-xs leading-normal text-warning-foreground">
              {detail.hiddenLength === 1
                ? `… ${detail.hiddenLength.toLocaleString()} character in the middle is not shown. The text ends with:`
                : `… ${detail.hiddenLength.toLocaleString()} characters in the middle are not shown. The text ends with:`}
            </Text>
            <ApprovalTextScroll parts={detail.tail} fromEnd />
          </>
        ) : (
          <ApprovalTextParts parts={detail.parts} />
        )
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
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {warning ? (
        <Text className="font-sans text-xs leading-normal text-warning-foreground">{warning}</Text>
      ) : null}
    </>
  );
  const actions = (
    <View className="gap-3" onLayout={measure("actions")}>
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
    </View>
  );
  const scrollProps = {
    bounces: false,
    className: "min-h-0",
    contentContainerClassName: "gap-3",
    keyboardShouldPersistTaps: "handled",
    nestedScrollEnabled: true,
    style: { flexShrink: 1 },
  } as const;

  return (
    <Animated.View
      className="gap-3 overflow-hidden rounded-[20px] border border-border bg-card-alt p-4"
      style={props.maxHeightStyle}
      onLayout={measure("card")}
    >
      {pinned ? (
        <>
          {header}
          <ScrollView {...scrollProps}>{request}</ScrollView>
          {actions}
        </>
      ) : (
        // Too little room to pin the actions beside the request: scroll everything so they stay reachable.
        <ScrollView {...scrollProps}>
          {header}
          {request}
          {actions}
        </ScrollView>
      )}
    </Animated.View>
  );
}

/**
 * One end of text too long to show in full, in a box that scrolls on its own, so the note, the
 * other end and the buttons stay within reach. The end opens on its last line.
 */
function ApprovalTextScroll(props: {
  readonly parts: ReadonlyArray<ApprovalTextPart>;
  readonly fromEnd?: boolean;
}) {
  const box = useRef<ComponentRef<typeof ScrollView>>(null);
  return (
    <ScrollView
      ref={box}
      className="max-h-40"
      nestedScrollEnabled
      onContentSizeChange={
        props.fromEnd ? () => box.current?.scrollToEnd({ animated: false }) : undefined
      }
    >
      <ApprovalTextParts parts={props.parts} />
    </ScrollView>
  );
}

function ApprovalTextParts(props: { readonly parts: ReadonlyArray<ApprovalTextPart> }) {
  return (
    <Text selectable className="font-sans text-sm leading-normal text-foreground-secondary">
      {props.parts.map((part, index) =>
        part.named ? (
          // Tinted only: a second font inside wrapped lines makes Android lay the text out shorter
          // than it draws, which cuts off its last lines.
          // oxlint-disable-next-line react/no-array-index-key -- parts never reorder and two may read alike
          <Text key={index} className="text-warning-foreground">
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}
