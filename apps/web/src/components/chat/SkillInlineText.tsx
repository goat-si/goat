import { useGT } from "gt-react";
import type { ScopedThreadRef, ServerProviderSkill } from "@goat/contracts";
import { formatProviderSkillDisplayName } from "@goat/shared/inlineSkills";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { matchInlineSkills } from "@goat/shared/inlineSkills";

import { useRightPanelStore } from "~/rightPanelStore";
import { SKILL_CHIP_ICON_SVG } from "../composerInlineChip";
import { ContextChipPopover } from "../contextChipParts";
import { Button } from "../ui/button";
import { PopoverClose } from "../ui/popover";

function SkillInlineText(props: {
  text: string;
  skills: ReadonlyArray<ServerProviderSkill>;
  threadRef: ScopedThreadRef | undefined;
}) {
  const nodes: ReactNode[] = [];
  let cursor = 0;

  for (const { start, end, skill, rawText } of matchInlineSkills(props.text, props.skills)) {
    if (start > cursor) {
      nodes.push(props.text.slice(cursor, start));
    }
    nodes.push(
      <SkillChip
        key={`${start}:${skill.name}`}
        skill={skill}
        rawText={rawText}
        threadRef={props.threadRef}
      />,
    );
    cursor = end;
  }

  if (cursor === 0) {
    return <>{props.text}</>;
  }
  if (cursor < props.text.length) {
    nodes.push(props.text.slice(cursor));
  }
  return <>{nodes}</>;
}

export function renderSkillInlineMarkdownChildren(
  children: ReactNode,
  skills: ReadonlyArray<ServerProviderSkill>,
  threadRef: ScopedThreadRef | undefined,
): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      return <SkillInlineText text={child} skills={skills} threadRef={threadRef} />;
    }
    if (!isValidElement<{ children?: ReactNode; node?: { tagName?: string } }>(child)) {
      return child;
    }
    // Custom markdown components replace intrinsic types; check their hast tags.
    const markdownTagName = typeof child.type === "string" ? child.type : child.props.node?.tagName;
    if (markdownTagName === "code" || markdownTagName === "a") {
      return child;
    }
    if (!("children" in child.props)) {
      return child;
    }
    return cloneElement(
      child,
      undefined,
      renderSkillInlineMarkdownChildren(child.props.children, skills, threadRef),
    );
  });
}

function SkillChip(props: {
  skill: ServerProviderSkill;
  rawText: string;
  threadRef: ScopedThreadRef | undefined;
}) {
  const gt = useGT();
  const label = formatProviderSkillDisplayName(props.skill);
  const description = props.skill.description?.trim() || props.skill.shortDescription?.trim();
  return (
    <SkillDetailsPopover label={label} description={description} copyMarkdown={props.rawText}>
      {props.threadRef && props.skill.path ? (
        <PopoverClose
          render={<Button variant="outline" size="sm" />}
          onClick={() => {
            if (props.threadRef)
              useRightPanelStore.getState().openFile(props.threadRef, props.skill.path);
          }}
        >
          {gt("View instructions")}
        </PopoverClose>
      ) : null}
    </SkillDetailsPopover>
  );
}

export function SkillDetailsPopover(props: {
  label: string;
  description: string | null | undefined;
  copyMarkdown?: string;
  children: ReactNode;
}) {
  const gt = useGT();
  return (
    <ContextChipPopover
      kind="skill"
      icon={<SkillChipIcon />}
      label={props.label}
      accessibleLabel={gt("Skill {skill}", { skill: props.label })}
      {...(props.copyMarkdown === undefined ? {} : { copyMarkdown: props.copyMarkdown })}
    >
      <div className="space-y-3 p-2 text-sm">
        <p className="font-medium">{props.label}</p>
        <p>{props.description || gt("No description is available for this skill.")}</p>
        {props.children}
      </div>
    </ContextChipPopover>
  );
}

export function SkillChipIcon() {
  return (
    <span
      aria-hidden="true"
      className="contents"
      dangerouslySetInnerHTML={{ __html: SKILL_CHIP_ICON_SVG }}
    />
  );
}
