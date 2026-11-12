import {
  GOAT_CONTEXT_CLIPBOARD_ATTRIBUTE,
  GOAT_CONTEXT_CLIPBOARD_UTI,
} from "@goat/contracts/legacyT3Names";
import { decodeComposerContextFragment } from "@goat/shared/composerContextClipboard";
import {
  collectComposerContextReferences,
  formatComposerContextHref,
  formatComposerContextReference,
} from "@goat/shared/composerContextReferences";
import {
  markdownForNativeRendering,
  markdownWithFileEmbeds,
  markdownForNativeParsing,
  markdownWithInlineFileLinks,
  markdownWithTableBreaks,
} from "../lib/markdownDocument";
import { isValidElement, useCallback, useMemo, useState, type ReactNode } from "react";
import { Platform, Share, View } from "react-native";
import {
  EnrichedMarkdownText,
  type MarkdownImageBlock,
  type MarkdownLinkOccurrence,
} from "react-native-enriched-markdown";
import type { SelectableMarkdownTextProps } from "./SelectableMarkdownText.types";

import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";
import { Menu } from "../components/ui/Menu";
import { useEnrichedLinkVariants } from "./useEnrichedLinkVariants";
import { useRetryingImageSource } from "./useRetryingImageSource";
import { markdownImageSources } from "../lib/markdownImageSources";
import { enrichedStyle } from "./enrichedMarkdownStyle";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import {
  ENRICHED_INLINE_FILE_LINK_REGEX,
  enrichedSkillLinkRegex,
  enrichedLinkVariantPattern,
} from "../lib/enrichedLinkPresentation";

export function MobileEnrichedMarkdownText(props: SelectableMarkdownTextProps) {
  const { renderImage, resolveImageSource, fileEmbedLabel } = props;
  const { themeAppearance, mathRenderingEnabled } = useAppearancePreferences();
  const { markdown, fileHrefs } = useMemo(() => {
    if (props.preserveMarkdownSource) {
      return { markdown: props.markdown, fileHrefs: new Set<string>() };
    }
    if (!fileEmbedLabel) {
      return {
        markdown: markdownForNativeRendering(props.markdown, ENRICHED_INLINE_FILE_LINK_REGEX),
        fileHrefs: new Set<string>(),
      };
    }
    const content = markdownWithInlineFileLinks(
      markdownForNativeParsing(props.markdown),
      ENRICHED_INLINE_FILE_LINK_REGEX,
    );
    const files = markdownWithFileEmbeds(content, fileEmbedLabel);
    return { ...files, markdown: markdownWithTableBreaks(files.markdown) };
  }, [props.markdown, props.preserveMarkdownSource, fileEmbedLabel]);
  const [parsedLinkUrls, setParsedLinkUrls] = useState<ReadonlyArray<string>>([]);
  const onLinksChange = useCallback((links: MarkdownLinkOccurrence[]) => {
    const urls = [...new Set(links.map((link) => link.url))];
    setParsedLinkUrls((previous) =>
      previous.length === urls.length && previous.every((url, index) => url === urls[index])
        ? previous
        : urls,
    );
  }, []);
  const skillRegex = useMemo(() => enrichedSkillLinkRegex(props.skills), [props.skills]);
  // Skill links come from linkRecognition, which runs as the text is drawn, so
  // onLinksChange never reports them. Joined so a streaming tick keeps the value.
  const skillLinkKey = useMemo(
    () =>
      skillRegex
        ? [...new Set(markdown.match(new RegExp(skillRegex.source, "gu")) ?? [])].join("\n")
        : "",
    [markdown, skillRegex],
  );
  const linkUrls = useMemo(
    () =>
      skillLinkKey
        ? [...new Set([...parsedLinkUrls, ...skillLinkKey.split("\n")])]
        : parsedLinkUrls,
    [parsedLinkUrls, skillLinkKey],
  );
  const { linkVariants, linkPillContent } = useEnrichedLinkVariants(linkUrls, props, fileHrefs);
  const linkRecognition = useMemo(() => ({ text: skillRegex ?? undefined }), [skillRegex]);
  const [activeMenu, setActiveMenu] = useState<{
    url: string;
    menu: NonNullable<ReturnType<NonNullable<typeof props.fileContextMenu>>>;
  } | null>(null);
  const { fileContextMenu, onFileContextMenuAction } = props;
  const onLinkPress = useCallback(
    (url: string) =>
      (fileHrefs.has(url) ? (props.onImagePress ?? props.onLinkPress) : props.onLinkPress)?.(url),
    [fileHrefs, props.onImagePress, props.onLinkPress],
  );
  const performMenuAction = useCallback(
    (url: string, actionId: string) => {
      if (actionId === "enriched-open-link") onLinkPress(url);
      else if (actionId === "enriched-copy-link") copyTextWithHaptic(url);
      else if (actionId === "enriched-share-link") void Share.share({ message: url });
      else onFileContextMenuAction?.(url, actionId);
    },
    [onLinkPress, onFileContextMenuAction],
  );
  const linkContextMenuItems = useMemo(
    () =>
      Platform.OS === "ios" && (fileContextMenu || props.onLinkPress || props.onImagePress)
        ? Object.fromEntries(
            linkUrls.map((url) => {
              const menu = fileContextMenu?.(url) ?? {
                title: url,
                actions: [
                  { id: "enriched-open-link", title: "Open link" },
                  { id: "enriched-copy-link", title: "Copy link" },
                  { id: "enriched-share-link", title: "Share link" },
                ],
              };
              return [
                enrichedLinkVariantPattern(url),
                menu.actions.map((action) => ({
                  text: action.title,
                  disabled: "disabled" in action && action.disabled,
                  onPress: () => performMenuAction(url, action.id),
                })),
              ];
            }),
          )
        : undefined,
    [linkUrls, fileContextMenu, props.onLinkPress, props.onImagePress, performMenuAction],
  );
  const selectionClipboard = useMemo(() => {
    const fragment = decodeComposerContextFragment(props.contextClipboardFragment);
    if (!fragment) return undefined;
    const references = collectComposerContextReferences(props.markdown);
    const linkTextByUrl = Object.fromEntries(
      references.flatMap((reference) => {
        const record = fragment.records.find((entry) => entry.contextId === reference.contextId);
        return record
          ? [
              [
                formatComposerContextHref(reference.kind, reference.contextId),
                formatComposerContextReference({ ...reference, label: record.label }),
              ],
            ]
          : [];
      }),
    );
    return {
      linkTextByUrl,
      htmlAttributes: {
        [GOAT_CONTEXT_CLIPBOARD_ATTRIBUTE]: encodeURIComponent(props.contextClipboardFragment!),
      },
      mimeTypes: { [GOAT_CONTEXT_CLIPBOARD_UTI]: props.contextClipboardFragment! },
    };
  }, [props.contextClipboardFragment, props.markdown]);
  const markdownStyle = useMemo(() => {
    const style = enrichedStyle(props.textStyle, themeAppearance === "dark");
    return {
      ...style,
      paragraph: props.textAlign
        ? { ...style.paragraph, textAlign: props.textAlign }
        : style.paragraph,
      linkVariants,
    };
  }, [props.textStyle, props.textAlign, themeAppearance, linkVariants]);
  const renderers = useMemo(
    () =>
      renderImage
        ? {
            image: (block: MarkdownImageBlock) => {
              const element = renderImage({
                href: block.url,
                alt: block.altText || null,
                title: block.title || null,
              });
              return isValidElement(element) ? element : undefined;
            },
          }
        : undefined,
    [renderImage],
  );
  const resolveNativeImageSource = useRetryingImageSource(resolveImageSource);
  // Enriched asks about each image once, so a moved loopback address needs a fresh native view.
  const imageRouteKey = useMemo(() => {
    const routeKey = resolveImageSource?.routeKey;
    if (!routeKey) return "";
    return (
      markdownImageSources(props.markdown)
        .map(routeKey)
        .find((key) => key !== null) ?? ""
    );
  }, [props.markdown, resolveImageSource]);
  const renderMarkdown = (openAndroidMenu?: () => void) => {
    const onLinkLongPress =
      Platform.OS === "android" && props.fileContextMenu
        ? ({ url }: { url: string }) => {
            const menu = props.fileContextMenu?.(url) ?? {
              title: url,
              actions: [
                { id: "enriched-open-link", title: "Open link" },
                { id: "enriched-copy-link", title: "Copy link" },
              ],
            };
            setActiveMenu({ url, menu });
            openAndroidMenu?.();
          }
        : Platform.OS === "android" && props.onLinkLongPress
          ? ({ url }: { url: string }) => props.onLinkLongPress?.(url)
          : undefined;

    return (
      <View
        style={{
          flexShrink: 1,
          minWidth: 0,
          marginTop: props.marginTop,
          marginBottom: props.marginBottom,
        }}
      >
        <EnrichedMarkdownText
          key={imageRouteKey}
          markdown={markdown}
          markdownStyle={markdownStyle}
          writingDirection={props.writingDirection}
          onLinksChange={onLinksChange}
          renderers={renderers}
          resolveImageSource={resolveNativeImageSource}
          onImagePress={
            props.onImagePress || props.onLinkPress
              ? ({ url }) => (props.onImagePress ?? props.onLinkPress)?.(url)
              : undefined
          }
          linkRecognition={linkRecognition}
          containerStyle={{ flexShrink: 1, minWidth: 0 }}
          flavor="github"
          selectable
          selectionClipboard={selectionClipboard}
          selectionColor={props.textStyle.selectionColor}
          selectionHandleColor={props.textStyle.selectionHandleColor}
          md4cFlags={{
            latexMath: mathRenderingEnabled,
            hardSoftBreaks: props.preserveSoftBreaks ?? false,
            admonitions: true,
            preserveWindowsPaths: true,
          }}
          enableTaskListItemToggle={props.onTaskListItemPress !== undefined}
          onTaskListItemPress={props.onTaskListItemPress}
          enableCodeBlockWrapToggle
          spoilerOverlay="solid"
          onLinkPress={
            props.onLinkPress || props.onImagePress ? ({ url }) => onLinkPress(url) : undefined
          }
          onLinkLongPress={onLinkLongPress}
          linkContextMenuItems={linkContextMenuItems}
          linkPillContent={linkPillContent}
        />
      </View>
    );
  };

  return Platform.OS === "android" && props.fileContextMenu ? (
    <Menu
      shouldOpenOnLongPress
      title={activeMenu?.menu.title}
      actions={
        activeMenu?.menu.actions.map((action) => ({
          id: action.id,
          title: action.title,
          attributes: { disabled: action.disabled },
        })) ?? []
      }
      onPressAction={({ nativeEvent }) => {
        if (activeMenu) performMenuAction(activeMenu.url, nativeEvent.event);
      }}
      style={{ flexShrink: 1, minWidth: 0 }}
    >
      <MarkdownMenuAnchor renderMarkdown={renderMarkdown} />
    </Menu>
  ) : (
    renderMarkdown()
  );
}

function MarkdownMenuAnchor(props: {
  readonly renderMarkdown: (openMenu?: () => void) => ReactNode;
  readonly onLongPress?: () => void;
}) {
  return props.renderMarkdown(props.onLongPress);
}
