import type { AnimationEvent } from "react";

export function synchronizeSidebarSpinner(event: AnimationEvent<SVGSVGElement>) {
  if (event.animationName !== "spin") return;

  // Every running row shares the document timeline phase.
  for (const animation of event.currentTarget.getAnimations()) {
    if ("animationName" in animation && animation.animationName === "spin") {
      animation.startTime = 0;
    }
  }
}
