import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, Handoff, ScopedThreadRef } from "@goat/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";
import { ShieldQuestionIcon } from "~/components/solar";
import { decisionInbox } from "../../state/decisionInbox";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackContent, ComposerBannerStackItem } from "./ComposerBannerStack";
import { HandoffCard } from "./HandoffCard";

// Up to two show in full; past two, one row stands for them all so the composer stays in view.
const MAX_SEPARATE_APPROVALS = 2;

function DockedApproval(props: { environmentId: EnvironmentId; handoff: Handoff }) {
  return (
    <div role="alert" className="flex min-w-0 gap-2">
      <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
        <ShieldQuestionIcon />
      </ComposerBanner.Icon>
      <div className="min-w-0 grow">
        <HandoffCard
          environmentId={props.environmentId}
          handoff={props.handoff}
          inherited={false}
          layout="dock"
        />
      </div>
    </div>
  );
}

/**
 * Every open approval of the thread, above the composer until a person answers it. They have no
 * dismiss: an approval leaves when it is answered, expires or is withdrawn.
 */
function approvalBannerItems(input: {
  readonly environmentId: EnvironmentId;
  readonly handoffs: ReadonlyArray<Handoff>;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}): Array<ComposerBannerStackItem | ComposerBannerStackContent> {
  const { environmentId, handoffs } = input;
  if (handoffs.length === 0) return [];
  // One banner holds them, so the stack never tucks the second one behind other notices.
  if (handoffs.length <= MAX_SEPARATE_APPROVALS)
    return [
      {
        id: "approvals",
        variant: "info",
        priority: "urgent",
        content: (
          <div className="flex flex-col gap-3">
            {handoffs.map((handoff) => (
              <DockedApproval
                key={handoff.handoffId}
                environmentId={environmentId}
                handoff={handoff}
              />
            ))}
          </div>
        ),
      },
    ];
  return [
    {
      id: "approvals",
      variant: "info",
      priority: "urgent",
      icon: <ShieldQuestionIcon />,
      title: `${handoffs.length} approvals need you`,
      actions: (
        <Button size="xs" variant="ghost" aria-expanded={input.expanded} onClick={input.onToggle}>
          {input.expanded ? "Hide" : "Show"}
        </Button>
      ),
      ...(input.expanded
        ? {
            children: (
              <ComposerBanner.Scroll>
                <div className="flex flex-col gap-3 pt-2">
                  {handoffs.map((handoff) => (
                    <DockedApproval
                      key={handoff.handoffId}
                      environmentId={environmentId}
                      handoff={handoff}
                    />
                  ))}
                </div>
              </ComposerBanner.Scroll>
            ),
          }
        : {}),
    },
  ];
}

const NO_APPROVALS = Atom.make<ReadonlyArray<Handoff>>([]).pipe(
  Atom.withLabel("no-open-approvals"),
);

/** The composer banners for the open approvals of the thread on screen. */
export function useApprovalBanners(ref: ScopedThreadRef | null) {
  const handoffs = useAtomValue(ref === null ? NO_APPROVALS : decisionInbox.openApprovalsAtom(ref));
  const [expanded, setExpanded] = useState(false);
  if (ref === null) return [];
  return approvalBannerItems({
    environmentId: ref.environmentId,
    handoffs,
    expanded,
    onToggle: () => setExpanded((value) => !value),
  });
}

/** The approval the timeline names while the thread waits: the provider's, else the newest handoff. */
export function useAwaitingApprovalId(
  ref: ScopedThreadRef | null,
  runtimeApprovalId: string | undefined,
) {
  const handoffs = useAtomValue(ref === null ? NO_APPROVALS : decisionInbox.openApprovalsAtom(ref));
  return runtimeApprovalId ?? handoffs.at(-1)?.handoffId ?? null;
}
