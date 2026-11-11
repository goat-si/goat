import type { ComposerPromptSegment } from "./composer-editor-mentions";
import type { SkillMeta } from "./composer-rich-text-doc";

type InlineJson = Record<string, unknown>;

function randomNodeKey(): string {
  return `tiptap-${Math.random().toString(36).slice(2)}`;
}

/** Null for a `$name` that is not one of the provider's skills: it stays editable text. */
export function atomJsonForSegment(
  segment: Exclude<ComposerPromptSegment, { type: "text" }>,
  skillLabelFor: (name: string) => SkillMeta | null,
): InlineJson | null {
  if (segment.type === "mention") {
    return {
      type: "composer-mention",
      attrs: { path: segment.path, source: segment.source },
    };
  }
  if (segment.type === "skill") {
    const meta = skillLabelFor(segment.name);
    if (!meta) return null;
    return {
      type: "composer-skill",
      attrs: {
        skillName: segment.name,
        skillLabel: meta.label,
        skillDescription: meta.description,
      },
    };
  }
  if (segment.type === "model") {
    return {
      type: "composer-model",
      attrs: { instanceId: segment.instanceId, model: segment.model, source: segment.source },
    };
  }
  if (segment.type === "citation") {
    return {
      type: "composer-citation",
      attrs: { citation: segment.citation, source: segment.source, citeKey: randomNodeKey() },
    };
  }
  return {
    type: "composer-context-reference",
    attrs: {
      kind: segment.kind,
      contextId: segment.contextId,
      label: segment.label,
      source: segment.source,
    },
  };
}
