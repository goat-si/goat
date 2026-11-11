import { type GoatBotReplyRepository, splitGoatBotTextLinks } from "@goat/client-runtime/goatBot";
import { useMemo } from "react";
import { Text } from "react-native";

import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { goatBotChangeRequestParts } from "./goatBotChangeRequestText";
import { showGoatBotLinkActions } from "./goatBotLinkActions";

/**
 * Bot text with its web addresses tappable. Rendered inside a parent Text so links wrap with the
 * words around them and keep the bubble's colour, underlined.
 */
export function GoatBotLinkedText({
  text,
  repository,
}: {
  readonly text: string;
  /** The whole reply's repository when this is one card of it; absent, the text is the reply. */
  readonly repository?: GoatBotReplyRepository | null | undefined;
}) {
  // Pull request addresses read as short references, as on web; quoted code stays as written.
  const parts = useMemo(
    () => goatBotChangeRequestParts(splitGoatBotTextLinks(text), text, repository),
    [text, repository],
  );
  return parts.map((part, index) => {
    if (part.kind === "text") return part.text;
    const open = () => void tryOpenExternalUrl(part.url, "goat-bot-link");
    return (
      <Text
        // oxlint-disable-next-line react/no-array-index-key -- parts are positional and never reorder
        key={index}
        accessibilityRole="link"
        // A short label names its address too, so a screen reader hears where it goes.
        accessibilityLabel={part.text === part.url ? part.url : `${part.text}, ${part.url}`}
        accessibilityActions={[{ name: "activate" }, { name: "copy", label: "Copy link" }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "copy")
            void tryCopyTextWithHaptic(part.url, { target: "link" });
          else open();
        }}
        onPress={open}
        onLongPress={() => showGoatBotLinkActions(part.url, open)}
        style={{ textDecorationLine: "underline" }}
      >
        {part.text}
      </Text>
    );
  });
}
