import type { EnvironmentId } from "@goat/contracts";
import type { CodexArtifactTemplate } from "@goat/shared/codexArtifactTemplates";
import { memo } from "react";

import { useUniwindTheme } from "../../lib/useUniwindTheme";
import type {
  MarkdownImageRenderer,
  SelectableMarkdownSkill,
} from "../../native/SelectableMarkdownText";
import { withChipIcon } from "../../native/useEnrichedLinkVariants";
import { useContextChipIcons, useLiveThreadLinkLabels } from "../../state/entities";
import {
  AssistantMarkdownBlocks,
  type MarkdownLinkHandlers,
  type MarkdownStyleSet,
} from "./AssistantMarkdownBlocks";

export const AssistantMarkdownContent = memo(function AssistantMarkdownContent(props: {
  readonly markdown: string;
  readonly environmentId: EnvironmentId;
  readonly markdownStyles: MarkdownStyleSet;
  readonly linkHandlers: MarkdownLinkHandlers;
  readonly onUseArtifactTemplate?: ((template: CodexArtifactTemplate) => void) | undefined;
  readonly renderImage: MarkdownImageRenderer;
  readonly skills?: ReadonlyArray<SelectableMarkdownSkill> | undefined;
}) {
  const iconSubtleColor = useUniwindTheme()["--color-icon-subtle"];
  const liveMarkdown = useLiveThreadLinkLabels(props.markdown, props.environmentId);
  const threadIcons = useContextChipIcons(props.environmentId, liveMarkdown);
  const linkHandlers: MarkdownLinkHandlers = {
    ...props.linkHandlers,
    linkCustomization: (href) =>
      withChipIcon(props.linkHandlers.linkCustomization?.(href), threadIcons.get(href)),
  };

  return (
    <AssistantMarkdownBlocks
      markdown={liveMarkdown}
      iconSubtleColor={iconSubtleColor}
      markdownStyles={props.markdownStyles}
      linkHandlers={linkHandlers}
      onUseArtifactTemplate={props.onUseArtifactTemplate}
      renderImage={props.renderImage}
      skills={props.skills}
    />
  );
});
