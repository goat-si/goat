import type { GoatBotActivityLine, GoatBotActivityMark } from "@goat/client-runtime/goatBot";
import { memo, type ReactNode } from "react";
import { Pressable, Text, View } from "react-native";

import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

/** Aligned with the bot's message bubbles, like their captions. */
const INSET = 14;

/** A stretch of GOAT Bot's steps above the reply it led to, or a note that they ran elsewhere. */
export const GoatBotStepsMark = memo(function GoatBotStepsMark(props: {
  readonly mark: GoatBotActivityMark;
  /** The keys of the lines the person opened in this chat. */
  readonly opened: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
}) {
  const caption = useScaledTextRole("caption");
  const { mark } = props;
  if (mark.kind === "elsewhere")
    return (
      <Text className="text-foreground-muted" style={{ ...caption, marginLeft: INSET }}>
        {mark.host === null ? "Steps ran on another server" : "Steps ran on " + mark.host}
      </Text>
    );
  const line = mark.line;
  const open = props.opened.has(line.key);
  const text = lineText(line);
  // Collapsed earlier work is not loaded, so a line of it alone has nothing to open.
  if (line.steps.length === 0)
    return (
      <Text className="text-foreground-muted" style={{ ...caption, marginLeft: INSET }}>
        {text}
      </Text>
    );
  return (
    <View style={{ marginLeft: INSET, alignItems: "flex-start" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={text}
        accessibilityHint={open ? "Hides the steps" : "Shows the steps"}
        accessibilityState={{ expanded: open }}
        onPress={() => props.onToggle(line.key)}
        style={{ minHeight: 44, justifyContent: "center" }}
      >
        <Text className="text-foreground-muted" style={caption}>
          {text}
        </Text>
      </Pressable>
      {open ? (
        <View className="border-l border-border" style={{ paddingLeft: 12, gap: 2 }}>
          {line.earlier ? (
            <Text className="text-foreground-muted" style={caption}>
              Earlier work, not listed
            </Text>
          ) : null}
          {line.steps.map((step) => (
            <Text key={step.id} className="text-foreground-muted" style={caption}>
              {step.label}
              {step.state === "running"
                ? " · running"
                : step.state === "failed"
                  ? " · failed"
                  : null}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
});

/**
 * A row with the mark that belongs directly above it, if any. The row keeps the same parent
 * whether or not a mark shows, so a line arriving or a paused read never mounts it again.
 */
export function GoatBotStepsAbove(props: {
  readonly mark: GoatBotActivityMark | undefined;
  readonly opened: ReadonlySet<string>;
  readonly onToggle: (key: string) => void;
  readonly children: ReactNode;
}) {
  return (
    <View>
      {props.mark === undefined ? null : (
        <GoatBotStepsMark mark={props.mark} opened={props.opened} onToggle={props.onToggle} />
      )}
      {props.children}
    </View>
  );
}

function lineText(line: GoatBotActivityLine): string {
  const summary = line.live && line.steps.length > 0 ? line.summary + " so far" : line.summary;
  return line.failedCount > 0 ? summary + " · " + line.failedCount + " failed" : summary;
}
