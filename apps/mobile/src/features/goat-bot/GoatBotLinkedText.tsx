import { splitGoatBotTextLinks } from "@goat/client-runtime/goatBot";
import { useMemo } from "react";
import { Text } from "react-native";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";

/**
 * Bot text with its web addresses tappable. Rendered inside a parent Text so links wrap with the
 * words around them and keep the bubble's colour, underlined.
 */
export function GoatBotLinkedText({ text }: { readonly text: string }) {
  const parts = useMemo(() => splitGoatBotTextLinks(text), [text]);
  return parts.map((part, index) =>
    part.kind === "text" ? (
      part.text
    ) : (
      <Text
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
        key={index}
        accessibilityRole="link"
        onPress={() => void tryOpenExternalUrl(part.url, "goat-bot-link")}
        style={{ textDecorationLine: "underline" }}
      >
        {part.text}
      </Text>
    ),
  );
}
