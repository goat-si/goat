import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import { scopeThreadRef } from "@goat/client-runtime/environment";
import type { EnvironmentId } from "@goat/contracts";
import { parseThreadLinkHref, resolveThreadLinkRef } from "@goat/shared/threadLinks";
import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";

/**
 * Bot text that holds Markdown, rendered by the chat's native renderer in the bubble's type and
 * colour. Thread links open where the shown history lives; other links leave the app.
 */
export function GoatBotMarkdown(props: {
  readonly text: string;
  readonly textColor: string;
  readonly failed?: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const bodyText = useScaledTextRole("body");
  const danger = useUniwindTheme()["--color-danger-foreground"];
  const color = props.failed ? danger : props.textColor;
  const openLink = (href: string) => {
    const threadId = parseThreadLinkHref(href);
    if (threadId !== null && props.environmentId !== null) {
      const source = scopeThreadRef(props.environmentId, threadId);
      const target =
        resolveThreadLinkRef(source, appAtomRegistry.get(environmentThreadShells.threadRefsAtom)) ??
        source;
      props.onSelectThread({ environmentId: target.environmentId, id: target.threadId });
      return;
    }
    void tryOpenExternalUrl(href, "markdown-link");
  };
  const markdown = (
    <SelectableMarkdownText
      markdown={props.text}
      preserveSoftBreaks
      textStyle={{
        ...styles.nativeTextStyle,
        color,
        strongColor: color,
        mutedColor: color,
        fontSize: bodyText.fontSize,
        lineHeight: bodyText.lineHeight,
      }}
      onLinkPress={openLink}
    />
  );
  if (!props.failed) return markdown;
  // The status sits beside the text, never around it, so its links stay reachable.
  return (
    <View className="flex-row gap-1">
      <View accessible accessibilityLabel="Failed" className="pt-1">
        <SymbolView name="exclamationmark.circle" size={14} tintColor={danger} />
      </View>
      <View className="min-w-0 flex-1">{markdown}</View>
    </View>
  );
}
