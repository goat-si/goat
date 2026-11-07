import type { RuntimeRequestId } from "@goat/contracts";
import type { ThreadUserInputQuestion } from "@goat/client-runtime/state/thread-requests";
import {
  markdownProseDirection,
  textDirection,
  type TextDirection,
} from "@goat/shared/textDirection";
import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import {
  isPendingUserInputOptionSelected,
  type PendingUserInput,
  type PendingUserInputDraftAnswer,
} from "../../lib/threadActivity";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";

// Kept apart from PendingUserInputCardProps so the card can import this body
// without an import cycle.
type BodyProps = {
  readonly pendingUserInput: PendingUserInput;
  readonly drafts: Record<string, PendingUserInputDraftAnswer>;
  readonly respondingUserInputId: RuntimeRequestId | null;
  readonly onSelectOption: (
    requestId: RuntimeRequestId,
    question: ThreadUserInputQuestion,
    value: string,
  ) => void;
  readonly disabled?: boolean;
  readonly renderCustomAnswer: (
    question: PendingUserInput["questions"][number],
    draft: PendingUserInputDraftAnswer | undefined,
    disabled: boolean,
  ) => ReactNode;
};

/** Renders question text as markdown so agent-provided links open on tap. */
function QuestionText(props: {
  readonly markdown: string;
  readonly setDirection: TextDirection | undefined;
}) {
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
  return (
    <SelectableMarkdownText
      markdown={props.markdown}
      textStyle={styles.nativeTextStyle}
      writingDirection={markdownProseDirection(props.markdown)}
      textAlign={
        Platform.OS === "android" ? undefined : props.setDirection === "rtl" ? "right" : "left"
      }
      onLinkPress={(href) => void openLink(href)}
    />
  );
}

function proseDirectionStyle(text: string, setDirection: TextDirection | undefined) {
  const direction = textDirection(text);
  return {
    ...(direction ? { direction, writingDirection: direction } : null),
    textAlign: (direction === "rtl") === (setDirection === "rtl") ? "left" : "right",
  } as const;
}

export function PendingUserInputBody(props: BodyProps) {
  const setDirection = markdownProseDirection(
    props.pendingUserInput.questions
      .flatMap((question) => [
        question.header,
        question.question,
        ...question.options.flatMap((option) => [option.label, option.description ?? ""]),
      ])
      .join(" "),
  );
  const canRespond = props.pendingUserInput.responseCapability !== "not_resumable";
  const responseDisabled =
    Boolean(props.disabled) ||
    !canRespond ||
    props.respondingUserInputId === props.pendingUserInput.requestId;
  return (
    <View className="gap-2.5">
      {!canRespond ? (
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          The provider process for this request is no longer available. Interrupt or restart the run
          to continue.
        </Text>
      ) : null}
      {props.pendingUserInput.questions.map((question) => {
        const draft = props.drafts[question.id];
        return (
          <View key={question.id} className="gap-2 pt-1">
            <Text
              style={proseDirectionStyle(question.header, setDirection)}
              className="font-goat-medium text-xs text-foreground-muted"
            >
              {question.header}
            </Text>
            <QuestionText markdown={question.question} setDirection={setDirection} />
            <View className="gap-2">
              {question.options.map((option) => {
                const optionValue = option.value ?? option.label.trim();
                const selected = isPendingUserInputOptionSelected(question, draft, optionValue);
                const description =
                  option.description !== option.label ? option.description : undefined;
                return (
                  <Pressable
                    key={optionValue}
                    accessibilityRole={question.multiSelect ? "checkbox" : "radio"}
                    accessibilityState={{ checked: selected, disabled: responseDisabled }}
                    disabled={responseDisabled}
                    className={cn(
                      "min-h-12 w-full flex-row items-center gap-3 rounded-2xl border px-3.5 py-3",
                      selected ? "border-primary bg-primary/10" : "border-border bg-input",
                    )}
                    onPress={() =>
                      props.onSelectOption(props.pendingUserInput.requestId, question, optionValue)
                    }
                  >
                    <View className="min-w-0 flex-1 gap-0.5">
                      <Text
                        style={proseDirectionStyle(option.label, setDirection)}
                        className={cn(
                          "text-sm",
                          selected
                            ? "font-goat-bold text-foreground"
                            : "font-goat-medium text-foreground-secondary",
                        )}
                      >
                        {option.label}
                      </Text>
                      {description ? (
                        <Text
                          style={proseDirectionStyle(description, setDirection)}
                          className="font-sans text-sm leading-5 text-foreground-muted"
                        >
                          {description}
                        </Text>
                      ) : null}
                    </View>
                    {selected ? (
                      <SymbolView
                        name="checkmark.circle.fill"
                        size={18}
                        tintColorClassName="accent-primary"
                        type="monochrome"
                      />
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            {question.allowCustomAnswer !== false
              ? props.renderCustomAnswer(question, draft, responseDisabled)
              : null}
          </View>
        );
      })}
    </View>
  );
}
