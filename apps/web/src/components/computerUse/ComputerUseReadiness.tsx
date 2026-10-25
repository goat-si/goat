import {
  computerUseReadinessSteps,
  type ReadinessStepState,
} from "@goat/client-runtime/computerUse/readinessSteps";
import type {
  ComputerUseSetup,
  ComputerUseSetupStatus,
} from "@goat/client-runtime/computer-use-linux-setup";
import type { ComputerUseGrant, CuaHostStatus } from "@goat/contracts";
import type { ReactNode } from "react";

import { Badge } from "../ui/badge";

export interface ComputerUseReadinessProps {
  readonly readiness?: CuaHostStatus["readiness"];
  readonly platform?: CuaHostStatus["platform"] | undefined;
  readonly tools?: CuaHostStatus["tools"];
  readonly signals?: CuaHostStatus["signals"];
  /** Why agents got no driver, when it was a grant macOS has not given (#1399). */
  readonly block?: CuaHostStatus["block"];
  /** Why the driver last failed to start on the host, when it did. */
  readonly failure?: CuaHostStatus["failure"];
  /** What the host's screen allows now. */
  readonly display?: CuaHostStatus["display"];
  /** The host's name, so the Linux guide says which machine to act on. */
  readonly machine?: string;
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

const setupPresentation = {
  done: { label: "Done", variant: "success" },
  action: { label: "To do", variant: "error" },
  waiting: { label: "Waiting", variant: "warning" },
  limited: { label: "Limited", variant: "secondary" },
  unavailable: { label: "Unavailable", variant: "secondary" },
} as const satisfies Record<ComputerUseSetupStatus, { label: string; variant: string }>;

/** The Linux steps with what to do at that machine; commands are shown to copy, never run. */
function LinuxSetupGuide({ setup }: { setup: ComputerUseSetup }) {
  return (
    <section
      aria-label="Set up computer use on Linux"
      className="space-y-3 border-t border-border pt-3"
    >
      <h4 className="text-sm font-medium">Set up on Linux</h4>
      <ul className="space-y-3">
        {setup.steps.map((step, index) => (
          <li key={`${step.id}:${index}`} className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm">{step.title}</span>
              <Badge variant={setupPresentation[step.status].variant}>
                {setupPresentation[step.status].label}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">{step.detail}</p>
            {step.guidance.map((line) =>
              line.kind === "command" ? (
                <code
                  key={line.text}
                  className="block rounded-md bg-muted px-2 py-1 font-mono text-xs break-all select-all"
                >
                  {line.text}
                </code>
              ) : (
                <p key={line.text} className="text-xs text-muted-foreground">
                  {line.text}
                </p>
              ),
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

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
          : result.startsWithNextTurn
            ? "Computer use is ready on this host. It starts with the next agent turn."
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
      {result.linuxSetup ? <LinuxSetupGuide setup={result.linuxSetup} /> : null}
    </section>
  );
}
