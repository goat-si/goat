import { AppText as Text } from "../../components/ui/AppText";
import { useMarkdownCodeHighlight } from "./markdownCodeHighlightState";

export function ReplCodeText({
  code,
  theme,
}: {
  readonly code: string;
  readonly theme: "light" | "dark";
}) {
  const lines = useMarkdownCodeHighlight({ code, language: "typescript", theme, enabled: true });
  let offset = 0;
  const highlighted = lines?.flatMap((line, lineIndex) => {
    const separator = lineIndex > 0 ? "\n" : "";
    offset += separator.length;
    return [
      separator,
      ...line.map((token) => {
        const start = offset;
        offset += token.content.length;
        return (
          <Text key={start} style={token.color ? { color: token.color } : undefined}>
            {token.content}
          </Text>
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
