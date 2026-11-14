import { isProviderSkillUserInvocable } from "@goat/client-runtime/providerSkills";
import type { ServerProviderSkill } from "@goat/contracts";
import { assistantCitationLabel } from "@goat/shared/assistantCitations";
import { formatProviderSkillDisplayName } from "@goat/shared/inlineSkills";
import { fileBasename } from "@goat/shared/path";
import { turnCapabilityForContextId } from "@goat/shared/turnCapabilities";
import {
  CircleDashedIcon,
  GlobeIcon,
  ImageIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  MonitorIcon,
  MousePointerClickIcon,
  QuoteIcon,
  TerminalIcon,
} from "~/components/solar";
import type { ReactElement } from "react";
import { cn } from "~/lib/utils";

import { splitPromptIntoComposerSegments } from "~/composer-editor-mentions";
import { composerFileNeedsReattach } from "~/composerDraftStore";
import type {
  ComposerDraftContextRecord,
  ComposerDraftContextRecords,
} from "../composerContextPresentation";
import { ContextChip, ContextChipLabel } from "../ContextChip";
import { ContextChipShell } from "../contextChipParts";
import { PierreEntryIcon } from "./PierreEntryIcon";
import { SkillChipIcon } from "./SkillInlineText";

type Theme = "light" | "dark";

// Upload progress and PR state stay with the editor, so the row shows each reference by kind.
const CONTEXT_REFERENCE_ICONS: Record<
  ComposerDraftContextRecord["kind"],
  (label: string, theme: Theme) => ReactElement
> = {
  image: () => <ImageIcon />,
  file: (label, theme) => <PierreEntryIcon pathValue={label} kind="file" theme={theme} />,
  terminal: () => <TerminalIcon />,
  "preview-annotation": () => <MousePointerClickIcon />,
  "review-comment": () => <MessageCircleIcon />,
  thread: () => <MessagesSquareIcon />,
  "preview-tab": () => <MousePointerClickIcon />,
};

// Mirrors the editor's chip: only a draft record of the same kind resolves a reference.
function resolvedContextRecord(
  records: ComposerDraftContextRecords,
  kind: string,
  contextId: string,
): ComposerDraftContextRecord | null {
  const entry = records.get(contextId);
  if (entry === undefined || entry.kind !== kind) return null;
  if (entry.kind === "file" && composerFileNeedsReattach(entry.record)) return null;
  return entry;
}

/**
 * The draft as the editor's chips, drawn inert: the collapsed row is a single button that
 * expands the composer, so these chips carry no popovers, links or focus stops.
 */
type PreviewProps = {
  prompt: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  contextRecords: ComposerDraftContextRecords;
  theme: Theme;
};

export function CollapsedComposerPromptButton(
  props: PreviewProps & { showProviderUnavailable: boolean; onExpand: () => void },
) {
  return (
    <button
      type="button"
      data-chat-composer-transition-prompt="true"
      className={cn(
        "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-sm focus:outline-none",
        props.prompt.trim() ? "text-foreground" : "text-placeholder",
      )}
      onPointerDown={(event) => event.preventDefault()}
      onClick={props.onExpand}
      aria-label="Expand composer"
    >
      {props.prompt.trim() ? (
        <CollapsedComposerPromptPreview {...props} />
      ) : props.showProviderUnavailable ? (
        "Enable a provider in Settings"
      ) : (
        "Ask anything..."
      )}
    </button>
  );
}

export function CollapsedComposerPromptPreview(props: PreviewProps) {
  let offset = 0;
  return splitPromptIntoComposerSegments(props.prompt).map((segment) => {
    const key = offset;
    offset += segment.type === "text" ? segment.text.length : segment.source.length;
    switch (segment.type) {
      case "text":
        return segment.text;
      // The editor's model chip is a popover trigger, which cannot nest in the row's button.
      case "model":
        return segment.source;
      case "citation":
        return (
          <ContextChip key={key} kind="citation">
            <QuoteIcon aria-hidden="true" />
            <ContextChipLabel className="max-w-[16em]">
              {assistantCitationLabel(segment.citation)}
            </ContextChipLabel>
          </ContextChip>
        );
      case "mention":
        return (
          <ContextChipShell
            key={key}
            kind="mention"
            icon={<PierreEntryIcon pathValue={segment.path} kind="file" theme={props.theme} />}
            label={fileBasename(segment.path)}
          />
        );
      case "context-reference": {
        const capability =
          segment.kind === "capability" ? turnCapabilityForContextId(segment.contextId) : undefined;
        if (capability)
          return (
            <ContextChipShell
              key={key}
              kind="capability"
              icon={capability === "browser" ? <GlobeIcon /> : <MonitorIcon />}
              label={segment.label}
            />
          );
        const entry = resolvedContextRecord(props.contextRecords, segment.kind, segment.contextId);
        return entry ? (
          <ContextChipShell
            key={key}
            kind={entry.kind === "preview-tab" ? "thread" : entry.kind}
            icon={CONTEXT_REFERENCE_ICONS[entry.kind](segment.label, props.theme)}
            label={segment.label}
          />
        ) : (
          <ContextChipShell
            key={key}
            state="unresolved"
            icon={<CircleDashedIcon />}
            label={segment.label}
          />
        );
      }
      case "skill": {
        const skill = props.skills.find(
          (candidate) => candidate.name === segment.name && isProviderSkillUserInvocable(candidate),
        );
        return skill ? (
          <ContextChip key={key} kind="skill">
            <SkillChipIcon />
            <ContextChipLabel>{formatProviderSkillDisplayName(skill)}</ContextChipLabel>
          </ContextChip>
        ) : (
          segment.source
        );
      }
    }
  });
}
