import { PendingUserInputBody } from "./PendingUserInputBody";
import { Button } from "../../components/ui/Button";
import { QuestionAttachments } from "./QuestionAttachments";
import type { RuntimeRequestId } from "@goat/contracts";
import type { ThreadUserInputQuestion } from "@goat/client-runtime/state/thread-requests";
import { useCallback, useRef } from "react";
import { Platform, Pressable, ScrollView, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from "react-native-reanimated";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { type PendingUserInput, type PendingUserInputDraftAnswer } from "../../lib/threadActivity";

export interface PendingUserInputCardProps {
  readonly canOperateThread: boolean;
  readonly pendingUserInput: PendingUserInput;
  readonly maxHeight: DerivedValue<number>;
  readonly collapsed: boolean;
  readonly onToggleCollapsed: () => void;
  readonly onStopThread?: () => void;
  readonly cardProgress?: SharedValue<number>;
  readonly cardCoverage?: SharedValue<number>;
  readonly onInputFocusChange?: (focused: boolean) => void;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly answers: Record<string, string | ReadonlyArray<string>> | null;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly onSelectOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly onChangeCustomAnswer: (
    requestId: RuntimeRequestId,
    questionId: string,
    customAnswer: string,
  ) => void;
  readonly onSubmit: () => Promise<unknown>;
  readonly onDismiss: () => Promise<unknown>;
}

export function PendingUserInputCard(props: PendingUserInputCardProps) {
  const questionCount = props.pendingUserInput.questions.length;
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const isResponding = props.respondingUserInputId === props.pendingUserInput.requestId;
  const responseDisabled = !canRespond || isResponding;

  const defaultProgress = useSharedValue(1);
  const defaultCoverage = useSharedValue(0);
  const cardProgress = props.cardProgress ?? defaultProgress;
  const cardCoverage = props.cardCoverage ?? defaultCoverage;
  const { maxHeight } = props;
  const barHeightRef = useRef(0);
  const cardHeightRef = useRef(0);
  const cardHeight = useSharedValue(0);
  const notifyCoverage = useCallback(() => {
    // The card resizes with the keyboard every frame, so easing each sample would leave the
    // feed inset and floating controls trailing it.
    cardCoverage.set(Math.max(0, cardHeightRef.current - barHeightRef.current));
  }, [cardCoverage]);
  const handleBarLayout = useCallback(
    (event: LayoutChangeEvent) => {
      barHeightRef.current = event.nativeEvent.layout.height;
      notifyCoverage();
    },
    [notifyCoverage],
  );
  const handleCardLayout = useCallback(
    (event: LayoutChangeEvent) => {
      cardHeightRef.current = event.nativeEvent.layout.height;
      cardHeight.set(event.nativeEvent.layout.height);
      notifyCoverage();
    },
    [cardHeight, notifyCoverage],
  );
  const cardAnimatedStyle = useAnimatedStyle(() => {
    const progress = cardProgress.value;
    const travel = Platform.OS === "android" ? cardCoverage.value : cardHeight.value;
    return {
      maxHeight: maxHeight.value,
      opacity:
        Platform.OS === "android"
          ? Math.min(1, (progress * cardHeight.value) / Math.max(1, cardHeight.value - travel))
          : 1,
      transform: [{ translateY: (1 - progress) * travel }],
    };
  });
  // Android hit-tests inside the parent; its height is also the space the card takes below the feed.
  const androidBoundsStyle = useAnimatedStyle(() => ({
    paddingTop: cardCoverage.value * cardProgress.value,
  }));
  const overlayHeightStyle = useAnimatedStyle(() => ({ height: maxHeight.value }));

  const bar = (
    <View
      onLayout={handleBarLayout}
      pointerEvents={props.collapsed ? "auto" : "none"}
      accessibilityElementsHidden={!props.collapsed}
      importantForAccessibility={props.collapsed ? "auto" : "no-hide-descendants"}
      className="flex-row items-center gap-2 rounded-full border border-border bg-card-alt py-1 pl-4 pr-1"
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Expand user input, ${questionCount} question${
          questionCount === 1 ? "" : "s"
        }`}
        onPress={props.onToggleCollapsed}
        className="min-h-10 flex-1 flex-row items-center gap-2 active:opacity-70"
      >
        <SymbolView
          name="questionmark.bubble"
          size={13}
          tintColorClassName="accent-foreground-secondary"
          type="monochrome"
        />
        <Text className="font-goat-medium text-xs text-foreground-secondary">
          User input needed
        </Text>
        <Text className="font-sans text-xs text-foreground-muted">
          {questionCount} question{questionCount === 1 ? "" : "s"}
        </Text>
        <View className="flex-1" />
        <SymbolView
          name="chevron.up"
          size={12}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
        />
      </Pressable>
      {props.onStopThread ? (
        <ControlPill
          accessibilityLabel="Stop"
          icon="stop.fill"
          variant="danger"
          disabled={!props.canOperateThread}
          onPress={props.onStopThread}
        />
      ) : null}
    </View>
  );
  const card = (
    <Animated.View
      onLayout={handleCardLayout}
      pointerEvents={props.collapsed ? "none" : "auto"}
      accessibilityElementsHidden={props.collapsed}
      importantForAccessibility={props.collapsed ? "no-hide-descendants" : "auto"}
      className="overflow-hidden gap-3 rounded-[20px] border border-border bg-card-alt p-4"
      style={cardAnimatedStyle}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Collapse user input"
        onPress={props.onToggleCollapsed}
        className="flex-row items-start gap-2"
      >
        <View className="flex-1 gap-1.5">
          <View className="flex-row items-center gap-1.5">
            <SymbolView
              name="questionmark.bubble"
              size={13}
              tintColorClassName="accent-foreground-secondary"
              type="monochrome"
            />
            <Text className="font-goat-medium text-xs text-foreground-secondary">
              User input needed
            </Text>
          </View>
          <Text className="font-goat-bold text-lg text-foreground">
            Fill in the pending answers
          </Text>
        </View>
        <View className="h-8 w-8 items-center justify-center rounded-full bg-subtle-strong">
          <SymbolView
            name="chevron.down"
            size={13}
            tintColorClassName={"accent-icon-subtle"}
            type="monochrome"
          />
        </View>
      </Pressable>
      <ScrollView
        bounces={false}
        className="min-h-0"
        contentContainerClassName="gap-2.5 pb-1"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ flexShrink: 1 }}
      >
        <PendingUserInputBody
          pendingUserInput={props.pendingUserInput}
          drafts={props.drafts}
          respondingUserInputId={props.respondingUserInputId}
          onSelectOption={props.onSelectOption}
          renderCustomAnswer={(question, draft, disabled) => (
            <QuestionAttachments
              requestId={props.pendingUserInput.requestId}
              question={question}
              questions={props.pendingUserInput.questions}
              disabled={disabled}
              value={draft?.customAnswer ?? ""}
              onChangeText={(value) =>
                props.onChangeCustomAnswer(props.pendingUserInput.requestId, question.id, value)
              }
              onInputFocusChange={props.onInputFocusChange}
            />
          )}
        />
      </ScrollView>
      <Button
        label="Submit answers"
        fullWidth
        tone={props.answers ? "primary" : "secondary"}
        disabled={!props.canOperateThread || responseDisabled || props.answers === null}
        onPress={() => void props.onSubmit()}
      />
      {props.pendingUserInput.dismissible ? (
        <Button
          label="Dismiss without answering"
          tone="text"
          disabled={isResponding}
          onPress={() => void props.onDismiss()}
        />
      ) : null}
      {!props.canOperateThread ? (
        <Text className="font-sans text-xs text-foreground-tertiary">
          This connection cannot submit answers.
        </Text>
      ) : null}
    </Animated.View>
  );
  return (
    <Animated.View
      className="relative"
      style={Platform.OS === "android" ? androidBoundsStyle : undefined}
    >
      {bar}
      <Animated.View
        pointerEvents={props.collapsed ? "none" : "box-none"}
        className="absolute inset-x-0 bottom-0 justify-end overflow-hidden"
        style={overlayHeightStyle}
      >
        {card}
      </Animated.View>
    </Animated.View>
  );
}
