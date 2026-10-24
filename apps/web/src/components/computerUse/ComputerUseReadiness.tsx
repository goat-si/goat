import {
  computerUseReadinessSteps,
  type ReadinessStepState,
} from "@goat/client-runtime/computerUse/readinessSteps";
import type { ComputerUseGrant, CuaHostStatus } from "@goat/contracts";
import type { ReactNode } from "react";

import { Badge } from "../ui/badge";

export interface ComputerUseReadinessProps {
  readonly readiness?: CuaHostStatus["readiness"];
  readonly platform?: CuaHostStatus["platform"] | undefined;
  readonly tools?: CuaHostStatus["tools"];
  readonly signals?: CuaHostStatus["signals"];
  readonly renderGrantAction?: (
    grant: "accessibility" | "screenCapture",
    state: ComputerUseGrant,
    context: { isCurrent: boolean },
  ) => { action: ReactNode; detail?: ReactNode };
}

const statePresentation = {
  ok: { label: "Ready", variant: "success" },
  pending: { label: "Waiting", variant: "warning" },
  blocked: { label: "Needs attention", variant: "error" },
  unsupported: { label: "Unsupported", variant: "secondary" },
  unknown: { label: "Not checked", variant: "outline" },
} as const satisfies Record<ReadinessStepState, { label: string; variant: string }>;

export function ComputerUseReadiness({ renderGrantAction, ...input }: ComputerUseReadinessProps) {
  const result = computerUseReadinessSteps(input);
  // Steps that share a cause, such as a helper that has not reported, say it once.
  const said = new Set<string>();
  const once = (lines: ReadonlyArray<string>) =>
    lines.filter((line) => !said.has(line) && said.add(line));
  return (
    <section aria-label="Computer use readiness" className="space-y-3 px-4 pt-1 pb-4">
      <p role="status" className="text-sm font-medium">
        {result.ready
          ? "Computer use is ready on this host."
          : "Computer use setup needs attention."}
      </p>
      <ol className="space-y-4">
        {result.steps.map((step, index) => (
          <li key={step.id} className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-medium">
                {index + 1}. {step.title}
              </h4>
              <Badge variant={statePresentation[step.state].variant}>
                {statePresentation[step.state].label}
              </Badge>
            </div>
            {once(step.detail).map((line) => (
              <p key={line} className="text-xs text-muted-foreground">
                {line}
              </p>
            ))}
            {step.grants.map((row) => {
              const slot = renderGrantAction?.(row.grant, row.state, { isCurrent: row.isCurrent });
              return (
                <div key={row.grant} className="space-y-1 border-l border-border pl-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm">{row.title}</span>
                    <Badge variant={statePresentation[row.status].variant}>
                      {statePresentation[row.status].label}
                    </Badge>
                    {slot?.action}
                  </div>
                  {once(row.detail).map((line) => (
                    <p key={line} className="text-xs text-muted-foreground">
                      {line}
                    </p>
                  ))}
                  {slot?.detail}
                </div>
              );
            })}
          </li>
        ))}
      </ol>
    </section>
  );
}
