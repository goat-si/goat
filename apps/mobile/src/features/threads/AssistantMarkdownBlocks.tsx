import * as Haptics from "expo-haptics";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import {
  codexArtifactTemplatePresentationLabel,
  type CodexArtifactTemplate,
} from "@goat/shared/codexArtifactTemplates";
import {
  renderCodexInlineDirectivesAsMarkdown,
  splitCodexArtifactTemplateMarkdown,
} from "@goat/shared/codexMarkdownDirectives";
import { Button } from "../../components/ui/Button";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { splitMarkdownDetails } from "../../lib/markdownDetails";
import {
  SelectableMarkdownText,
  type MarkdownFileContextMenu,
  type MarkdownImageRenderer,
  type MarkdownImageSourceResolver,
  type MarkdownLinkCustomization,
  type NativeMarkdownTextStyle,
  type SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";
import { ThreadDisclosureChevron } from "./thread-work-log";

export interface MarkdownLinkHandlers {
  readonly onLinkPress: (href: string) => void;
  readonly fileContextMenu: (href: string) => MarkdownFileContextMenu | undefined;
  readonly onFileContextMenuAction: (href: string, actionId: string) => void;
  readonly onImagePress?: (href: string) => void;
  readonly resolveImageSource?: MarkdownImageSourceResolver;
  readonly fileEmbedLabel?: (href: string, standalone: boolean) => string | null;
  readonly linkCustomization?: (href: string) => MarkdownLinkCustomization | undefined;
}

export interface MarkdownStyleSet {
  readonly nativeTextStyle: NativeMarkdownTextStyle;
}

const ARTIFACT_TEMPLATE_SYMBOL_BY_KIND: Record<
  CodexArtifactTemplate["artifactKind"],
  AppSymbolName
> = {
  document: "doc.text",
  presentation: "chart.bar.xaxis",
  spreadsheet: "chart.bar.xaxis",
  site: "safari",
  "google-docs": "doc.text",
  "google-slides": "chart.bar.xaxis",
  "google-sheets": "chart.bar.xaxis",
  image: "camera",
  email: "text.bubble",
  slack: "text.bubble",
};

function ArtifactTemplateCard(props: {
  readonly template: CodexArtifactTemplate;
  readonly onUse?: ((template: CodexArtifactTemplate) => void) | undefined;
}) {
  return (
    <View className="my-2 min-w-0 flex-row items-center gap-3 rounded-2xl border border-border bg-card px-3 py-3">
      <View className="relative h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-border bg-subtle">
        <SymbolView
          name={ARTIFACT_TEMPLATE_SYMBOL_BY_KIND[props.template.artifactKind]}
          size={20}
          tintColorClassName="accent-foreground-muted"
          type="monochrome"
        />
        <View className="absolute -right-1 -bottom-1 h-4 w-4 items-center justify-center rounded-full bg-fuchsia-500">
          <SymbolView
            name={{ ios: "sparkles", android: "auto_awesome" }}
            size={9}
            tintColor="white"
            type="monochrome"
          />
        </View>
      </View>
      <View className="min-w-0 flex-1">
        <Text className="font-goat-bold text-sm text-foreground" numberOfLines={1}>
          {props.template.displayName}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {codexArtifactTemplatePresentationLabel(props.template.artifactKind)}
        </Text>
      </View>
      {props.onUse ? (
        <Button
          label="Use template"
          tone="secondary"
          accessibilityLabel={`Use ${props.template.displayName} template`}
          onPress={() => props.onUse?.(props.template)}
        />
      ) : null}
    </View>
  );
}

// Folds split first, so an artifact card inside a fold stays inside it.
export function AssistantMarkdownBlocks(props: {
  readonly markdown: string;
  readonly iconSubtleColor: string;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: MarkdownImageRenderer;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
}) {
  const blocks = useMemo(
    () =>
      splitMarkdownDetails(props.markdown).map((block) =>
        block.kind === "details"
          ? block
          : { ...block, segments: splitCodexArtifactTemplateMarkdown(block.markdown) },
      ),
    [props.markdown],
  );
  return blocks.map((block) => {
    if (block.kind === "details") {
      return (
        <MarkdownDetailsFold
          key={`details:${block.sourceOffset}`}
          summary={block.summary}
          initiallyOpen={block.open}
          iconSubtleColor={props.iconSubtleColor}
        >
          <AssistantMarkdownBlocks {...props} markdown={block.body} />
        </MarkdownDetailsFold>
      );
    }
    return block.segments.map((segment) => {
      const offset = block.sourceOffset + segment.sourceOffset;
      if (segment.kind === "artifact-template") {
        return (
          <ArtifactTemplateCard
            key={`artifact-template:${offset}`}
            template={segment.template}
            onUse={props.onUseArtifactTemplate}
          />
        );
      }
      if (segment.markdown.trim().length === 0) return null;
      return (
        <SelectableMarkdownText
          key={`markdown:${offset}`}
          markdown={renderCodexInlineDirectivesAsMarkdown(segment.markdown)}
          skills={props.skills}
          textStyle={props.markdownStyles.nativeTextStyle}
          {...props.linkHandlers}
          renderImage={props.renderImage}
        />
      );
    });
  });
}

function MarkdownDetailsFold(props: {
  readonly summary: string;
  readonly initiallyOpen: boolean;
  readonly iconSubtleColor: string;
  readonly children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(props.initiallyOpen);
  return (
    <View className="my-2 border-y border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.summary}
        accessibilityState={{ expanded }}
        hitSlop={4}
        className="min-h-10 flex-row items-center gap-2 py-2"
        onPress={() => {
          void Haptics.selectionAsync();
          setExpanded((value) => !value);
        }}
      >
        <ThreadDisclosureChevron
          expanded={expanded}
          collapsedDirection="right"
          size={12}
          tintColor={props.iconSubtleColor}
        />
        <Text className="min-w-0 shrink font-goat-medium text-sm text-foreground">
          {props.summary}
        </Text>
      </Pressable>
      {expanded ? <View className="pb-3 pl-5">{props.children}</View> : null}
    </View>
  );
}
