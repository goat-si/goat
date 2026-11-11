import type { GoatBotReplyRepository } from "@goat/client-runtime/goatBot";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import type { EnvironmentId } from "@goat/contracts";
import { useCallback, useMemo } from "react";
import { Platform, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { markdownLinkIcon } from "../../lib/markdownLinkIcons";
import { resolveMarkdownLinkPresentation } from "../../lib/markdownLinks";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import {
  type MarkdownLinkCustomization,
  SelectableMarkdownText,
} from "../../native/SelectableMarkdownText";
import { appAtomRegistry } from "../../state/atom-registry";
import { environmentThreadShells } from "../../state/threads";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { showGoatBotLinkActions } from "./goatBotLinkActions";
import { goatBotMarkdownLinkTarget } from "./goatBotMarkdownLinks";
import { goatBotChangeRequestLinks } from "./goatBotChangeRequestText";

/**
 * Bot text that holds Markdown, rendered by the chat's native renderer in the transcript's type and
 * colour. Thread links open where the shown history lives; other links leave the app.
 */
export function GoatBotMarkdown(props: {
  readonly text: string;
  /** The whole reply's repository when this is one card of it; absent, the text is the reply. */
  readonly repository?: GoatBotReplyRepository | null | undefined;
  readonly failed?: boolean;
  readonly environmentId: EnvironmentId | null;
  readonly onSelectThread: (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) => void;
}) {
  const styles = useMarkdownPreviewStyles();
  const bodyText = useScaledTextRole("body");
  const theme = useUniwindTheme();
  const danger = theme["--color-danger-foreground"];
  const color = props.failed ? danger : theme["--color-foreground"];
  // Pull request links read as short references, as on web.
  const { markdown: text, labels } = useMemo(
    () => goatBotChangeRequestLinks(props.text, props.repository),
    [props.text, props.repository],
  );
  const linkColor = styles.nativeTextStyle.linkColor;
  // A short label drawn over an address the bot left bare, with the icon its host gets elsewhere.
  const linkCustomization = useCallback(
    (href: string): MarkdownLinkCustomization | undefined => {
      const label = labels.get(href);
      if (label === undefined) return undefined;
      const link = resolveMarkdownLinkPresentation(href);
      const icon = link.kind === "external" ? markdownLinkIcon(link.host) : null;
      return {
        label,
        color: linkColor,
        ...(icon ? { icon: icon.source, ...(icon.tints ? { iconTintColor: linkColor } : {}) } : {}),
      };
    },
    [labels, linkColor],
  );
  const openLink = (href: string) => {
    const target = goatBotMarkdownLinkTarget(
      href,
      props.environmentId,
      appAtomRegistry.get(environmentThreadShells.threadRefsAtom),
    );
    if (target?.kind === "thread") {
      props.onSelectThread({
        environmentId: target.thread.environmentId,
        id: target.thread.threadId,
      });
    } else if (target?.kind === "external") {
      void tryOpenExternalUrl(target.href, "markdown-link");
    }
  };
  const markdown = (
    <SelectableMarkdownText
      markdown={text}
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
      linkCustomization={linkCustomization}
      // iOS draws its own link menu, titled with the link's words: its first row names the address.
      fileContextMenu={Platform.OS === "ios" ? goatBotLinkMenu : undefined}
      onLinkLongPress={(href) => showGoatBotLinkActions(href, () => openLink(href))}
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

function goatBotLinkMenu(href: string) {
  return {
    title: href,
    actions: [
      { id: "goat-bot-link-address", title: href, disabled: true },
      { id: "enriched-open-link", title: "Open link" },
      { id: "enriched-copy-link", title: "Copy link" },
      { id: "enriched-share-link", title: "Share link" },
    ],
  };
}
