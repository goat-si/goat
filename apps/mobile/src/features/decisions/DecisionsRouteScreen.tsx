import { useIsFocused, useNavigation } from "@react-navigation/native";
import { ScrollView, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { AppBar } from "../../components/ui/AppBar";
import { useThreadShell } from "../../state/entities";
import { useSavedRemoteConnection } from "../../state/use-remote-environment-registry";
import { PendingApprovalCard } from "../threads/PendingApprovalCard";
import { PendingUserInputBody } from "../threads/PendingUserInputBody";
import { Button } from "../../components/ui/Button";
import { useDecisionInbox, useDecisionInboxSessionState } from "./useDecisionInbox";

export function DecisionsRouteScreen() {
  const focused = useIsFocused();
  const navigation = useNavigation();
  const session = useDecisionInboxSessionState();
  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <AppBar
        title="Decisions"
        sidebar={false}
        onBack={() => (navigation.canGoBack() ? navigation.goBack() : navigation.navigate("Home"))}
      />
      {focused ? (
        <FocusedDecisionsContent session={session} isFocused={() => navigation.isFocused()} />
      ) : null}
    </View>
  );
}

function FocusedDecisionsContent(props: {
  readonly session: ReturnType<typeof useDecisionInboxSessionState>;
  readonly isFocused: () => boolean;
}) {
  const {
    state,
    queue,
    current,
    position,
    paused,
    responding,
    drafts,
    answers,
    canOperateThread,
    error,
    skip,
    retry,
    onRespond,
    onSubmit,
    onSelectOption,
    onChangeCustomAnswer,
  } = useDecisionInbox(props.session, props.isFocused);
  const navigation = useNavigation();
  const thread = useThreadShell(current?.ref ?? null);
  const connection = useSavedRemoteConnection(current?.ref.environmentId ?? null);
  const insets = useSafeAreaInsets();
  const userInput = current?.kind === "user_input" ? current.request : null;
  const partial = state.loadingRefs.length > 0 || state.errors.length > 0;
  return (
    <ScreenContent>
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <ScrollView
          className="flex-1"
          contentContainerClassName="gap-4 px-4 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 24) }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Text className="text-sm text-foreground-muted">
            Pending questions and approvals from threads.
          </Text>
          <Button
            label="Decision inbox and history"
            tone="secondary"
            onPress={() =>
              navigation.navigate("SettingsSheet", {
                screen: "SettingsContent",
                params: { screen: "SettingsDecisionInbox" },
              })
            }
          />
          {state.loadingRefs.length > 0 ? (
            <Text className="text-sm text-foreground-muted">
              {current ? "Checking more decisions…" : "Loading decisions…"}
            </Text>
          ) : null}
          {paused ? (
            <Text className="text-sm text-foreground-muted">
              Checking this decision before you answer.
            </Text>
          ) : null}
          {state.errors.length > 0 ? (
            <View className="gap-3">
              <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                Some decisions could not be loaded.
              </Text>
              {state.errors.map(({ ref, message }) => (
                <View key={JSON.stringify([ref.environmentId, ref.threadId])} className="gap-2">
                  <Text className="text-sm text-foreground-muted">{message}</Text>
                  <Button
                    label="Go to thread"
                    tone="secondary"
                    onPress={() => navigation.navigate("Thread", ref)}
                  />
                </View>
              ))}
              <Button label="Retry" tone="secondary" onPress={retry} />
            </View>
          ) : null}
          {state.items.length === 0 && !partial ? (
            <EmptyState
              title="No pending thread requests"
              detail="Pending questions and approvals from connected environments will appear here."
            />
          ) : null}
          {current ? (
            <View key={current.id} className="gap-4">
              <Text className="text-sm text-foreground-muted">
                {partial
                  ? `${queue.length} loaded`
                  : `${queue.length} decision${queue.length === 1 ? "" : "s"} waiting`}
              </Text>
              <Text className="font-goat-bold text-sm text-foreground">
                {thread?.title ?? String(current.ref.threadId)}
              </Text>
              <Text className="text-xs text-foreground-muted">
                {connection?.environmentLabel ?? String(current.ref.environmentId)}
                {position > 0 ? ` · ${position} of ${queue.length}` : " · Checking decision"}
              </Text>
              {current.kind === "approval" ? (
                <PendingApprovalCard
                  approval={current.request}
                  canOperateThread={canOperateThread}
                  respondingApprovalId={responding ? current.request.requestId : null}
                  onRespond={onRespond}
                />
              ) : userInput ? (
                <View className="gap-3 rounded-[20px] border border-border bg-card-alt p-4">
                  <Text className="font-goat-bold text-lg text-foreground">
                    Fill in the pending answers
                  </Text>
                  <PendingUserInputBody
                    pendingUserInput={userInput}
                    drafts={drafts}
                    disabled={!canOperateThread || paused}
                    respondingUserInputId={responding ? userInput.requestId : null}
                    onSelectOption={onSelectOption}
                    renderCustomAnswer={(question, draft, disabled) => (
                      <TextInput
                        accessibilityLabel={question.question}
                        value={draft?.customAnswer ?? ""}
                        editable={!disabled}
                        multiline={question.initialAnswer !== undefined}
                        submitBehavior={
                          question.initialAnswer !== undefined ? "newline" : undefined
                        }
                        placeholder="Or type a custom answer"
                        onChangeText={(value) =>
                          onChangeCustomAnswer(userInput.requestId, question.id, value)
                        }
                        className="min-h-[54px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
                      />
                    )}
                  />
                  <Button
                    label={responding ? "Waiting for thread update…" : "Submit answers"}
                    fullWidth
                    tone={answers ? "primary" : "secondary"}
                    disabled={
                      !canOperateThread ||
                      paused ||
                      responding ||
                      answers === null ||
                      userInput.responseCapability === "not_resumable"
                    }
                    onPress={() => void onSubmit()}
                  />
                  {!canOperateThread && !paused ? (
                    <Text className="text-xs text-foreground-muted">
                      This connection cannot submit answers.
                    </Text>
                  ) : null}
                </View>
              ) : null}
              {error ? (
                <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
                  {error}
                </Text>
              ) : null}
              <View className="flex-row flex-wrap gap-3">
                <Button
                  label="Skip"
                  tone="secondary"
                  disabled={responding || paused}
                  onPress={skip}
                />
                <Button
                  label="Go to thread"
                  tone="secondary"
                  onPress={() => navigation.navigate("Thread", current.ref)}
                />
              </View>
              <Text className="text-xs text-foreground-muted">
                To answer with attachments, open the thread.
              </Text>
            </View>
          ) : null}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenContent>
  );
}
