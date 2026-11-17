import { useMemo } from "react";
import { Text as RNText } from "react-native";
import {
  commandHighlightLanguage,
  withVisibleControlCharacters,
} from "@goat/client-runtime/work-log/command-label";

import { AppText as Text } from "../../components/ui/AppText";
import { highlightCommand, type HighlightedLines } from "../../lib/highlights";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";

export function ReplCodeText({
  code,
  theme,
}: {
  readonly code: string;
  readonly theme: "light" | "dark";
}) {
  const lines = useMarkdownCodeHighlight({ code, language: "typescript", theme, enabled: true });
  return <HighlightedCodeText code={code} lines={lines} />;
}

/** A tool call's command, highlighted as on web, with the scripts it embeds in their own grammar. */
export function commandCodeText(command: string | null | undefined, theme: "light" | "dark") {
  return command ? <CommandCodeText key="command" command={command} theme={theme} /> : null;
}

function CommandCodeText({
  command,
  theme,
}: {
  readonly command: string;
  readonly theme: "light" | "dark";
}) {
  const code = withVisibleControlCharacters(command.trim());
  const lines = useMemo(
    () => highlightCommand(code, commandHighlightLanguage(code), theme),
    [code, theme],
  );
  return <HighlightedCodeText code={code} lines={lines} />;
}

function HighlightedCodeText({
  code,
  lines,
}: {
  readonly code: string;
  readonly lines: HighlightedLines | null;
}) {
  let offset = 0;
  const highlighted = lines?.flatMap((line, lineIndex) => {
    const separator = lineIndex > 0 ? "\n" : "";
    offset += separator.length;
    return [
      separator,
      ...line.map((token) => {
        const start = offset;
        offset += token.content.length;
        // Plain RN Text inherits the mono font; AppText would reset it to sans.
        return (
          <RNText key={start} style={token.color ? { color: token.color } : undefined}>
            {token.content}
          </RNText>
        );
      }),
    ];
  });
  return (
    <Text selectable className="font-mono text-2xs leading-normal text-foreground">
      {highlighted ?? code}
    </Text>
  );
}
