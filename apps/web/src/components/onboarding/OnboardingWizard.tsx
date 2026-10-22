import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps, ReactNode } from "react";

import { CheckIcon } from "~/components/solar";
import { cn } from "~/lib/utils";
import { AnimatedHeight } from "../AnimatedHeight";
import { DialogPopup } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";

/**
 * Onboarding look for setup wizards. The parts take the same props as ui/wizard, so a setup flow
 * switches by import while ui/wizard keeps serving the app's other multi-step dialogs.
 */
export function WizardPopup({
  children,
  size = "default",
  ...props
}: Omit<ComponentProps<typeof DialogPopup>, "className" | "style"> & {
  readonly size?: "default" | "wide";
}) {
  return (
    <DialogPopup {...props} className={size === "wide" ? "max-w-3xl" : "max-w-xl"}>
      <ScrollArea className="*:data-[slot=scroll-area-scrollbar]:data-[orientation=vertical]:my-4">
        <div className="flex min-h-0 flex-col">{children}</div>
      </ScrollArea>
    </DialogPopup>
  );
}

export function WizardHeader({
  title,
  description,
  identity,
  children,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly identity?: ReactNode;
  readonly children?: ReactNode;
}) {
  if (identity) {
    return (
      <div className="flex flex-col gap-5 px-6 pt-6 pb-5 sm:flex-row sm:items-center sm:justify-between sm:gap-8 sm:pe-14">
        <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
        <div className="goat-arrive shrink-0">{identity}</div>
        {children ? <div className="min-w-0 sm:w-full sm:max-w-sm">{children}</div> : null}
        {description ? (
          <DialogPrimitive.Description className="sr-only">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
    );
  }
  return (
    <div className="flex flex-col px-6 pt-6 pb-5 pe-14">
      <DialogPrimitive.Title className="goat-arrive font-brand text-xl leading-7 font-semibold text-balance text-foreground [word-break:keep-all]">
        {title}
      </DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description
          className="goat-arrive mt-1.5 text-sm leading-6 text-pretty text-muted-foreground [word-break:keep-all]"
          style={{ animationDelay: "40ms" }}
        >
          {description}
        </DialogPrimitive.Description>
      ) : null}
      {children ? <div className="mt-5">{children}</div> : null}
    </div>
  );
}

export function WizardFooter({
  children,
  leading,
}: {
  readonly children: ReactNode;
  readonly leading?: ReactNode;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "flex flex-col-reverse gap-3 px-6 pt-2 pb-6 sm:flex-row sm:items-center",
        leading ? "sm:justify-between" : "sm:justify-end",
      )}
    >
      {leading}
      <div className="flex flex-col-reverse gap-2 sm:flex-row">{children}</div>
    </div>
  );
}

/**
 * Segmented progress: one bar per step, the current one in the brand colour and labelled. Which
 * steps can be revisited is the caller's decision, through isStepDisabled.
 */
export function WizardSteps({
  steps,
  currentStep,
  summaries,
  showSummaries = false,
  onStepChange,
  isStepDisabled,
}: {
  readonly steps: readonly string[];
  readonly currentStep: number;
  readonly summaries?: readonly (string | null)[];
  readonly showSummaries?: boolean;
  readonly isStepDisabled?: (step: number) => boolean;
  readonly onStepChange?: (step: number) => void;
}) {
  const Step = onStepChange ? "button" : "div";
  return (
    <>
      <ol
        className="grid auto-cols-fr grid-flow-col gap-1.5"
        role="list"
        aria-label="Setup progress"
      >
        {steps.map((step, index) => {
          const done = index < currentStep;
          const current = index === currentStep;
          return (
            <li key={step} className="min-w-0">
              <Step
                {...(onStepChange
                  ? { type: "button" as const, disabled: isStepDisabled?.(index) }
                  : {})}
                className={cn(
                  "group flex w-full min-w-0 flex-col gap-2 rounded-md px-1 pt-1.5 pb-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                  onStepChange && "cursor-pointer disabled:cursor-default",
                )}
                aria-current={current ? "step" : undefined}
                aria-label={`${step}, step ${index + 1}${done && summaries?.[index] ? `, ${summaries?.[index]}` : ""}`}
                onClick={onStepChange ? () => onStepChange(index) : undefined}
              >
                <span
                  aria-hidden
                  className={cn(
                    "h-1 w-full rounded-full transition-colors duration-300",
                    current
                      ? "bg-primary"
                      : done
                        ? "bg-primary/45 group-enabled:group-hover:bg-primary/70"
                        : "bg-foreground/10 dark:bg-white/10",
                  )}
                />
                <span
                  className={cn(
                    "flex min-w-0 items-center gap-1 text-xs font-medium",
                    current ? "text-foreground" : "text-muted-foreground",
                    done && "group-enabled:group-hover:text-foreground",
                    "max-sm:sr-only",
                  )}
                >
                  {done ? <CheckIcon className="size-3 shrink-0 text-primary" aria-hidden /> : null}
                  <span className="truncate">
                    {step}
                    {showSummaries && done && summaries?.[index] ? `: ${summaries[index]}` : null}
                  </span>
                </span>
              </Step>
            </li>
          );
        })}
      </ol>
      <p aria-hidden className="mt-2 flex justify-between text-xs font-medium sm:hidden">
        <span className="truncate text-foreground">{steps[currentStep]}</span>
        <span className="shrink-0 text-muted-foreground tabular-nums">
          {currentStep + 1}/{steps.length}
        </span>
      </p>
    </>
  );
}

export function WizardPanel({
  children,
  holdHeight = false,
  className,
}: {
  readonly children: ReactNode;
  readonly holdHeight?: boolean;
  readonly className?: string;
}) {
  return (
    <div
      data-slot="dialog-panel"
      className={cn("min-w-0 space-y-4 border-t border-border/60 px-6 py-5", className)}
    >
      <AnimatedHeight holdHeight={holdHeight}>{children}</AnimatedHeight>
    </div>
  );
}
