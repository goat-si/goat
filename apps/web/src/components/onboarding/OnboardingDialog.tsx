import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import type { ComponentProps, ReactNode } from "react";

import { LaptopIcon, SettingsIcon } from "~/components/solar";
import { GoatWordmark } from "../GoatWordmark";
import { DialogPopup } from "../ui/dialog";
import { ScrollArea } from "../ui/scroll-area";

/**
 * Shared shell for first-run questions. Each one says what connects to what on which machine,
 * why it is asked now, the one next action, and where to change the answer later. Callers own
 * the surrounding <Dialog> so each question keeps its own close semantics.
 */
export function OnboardingPopup(props: Omit<ComponentProps<typeof DialogPopup>, "className">) {
  return <DialogPopup {...props} className="max-w-[27rem]" />;
}

const capitalize = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);

// Entrance offsets for the header parts; goat-arrive turns itself off under reduced motion.
const arrive = (delayMs: number) => ({ animationDelay: `${delayMs}ms` });

export function OnboardingHeader({
  host,
  art,
  title,
  description,
}: {
  /** The machine the answer applies to, such as "this Mac". */
  readonly host?: string | undefined;
  readonly art?: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
}) {
  return (
    <div className="flex flex-col px-6 pt-6">
      <div className="goat-arrive flex h-5 items-center gap-2.5 pe-8 text-muted-foreground">
        <GoatWordmark className="h-4 w-auto shrink-0 text-foreground" aria-hidden />
        {host ? (
          <>
            <span aria-hidden className="h-3 w-px bg-border" />
            <span className="inline-flex min-w-0 items-center gap-1.5 text-xs font-medium">
              <LaptopIcon className="size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{capitalize(host)}</span>
            </span>
          </>
        ) : null}
      </div>
      {art ? <div className="mt-4">{art}</div> : null}
      <DialogPrimitive.Title
        className="goat-arrive mt-5 font-brand text-xl leading-7 font-semibold text-balance text-foreground [word-break:keep-all]"
        style={arrive(40)}
      >
        {title}
      </DialogPrimitive.Title>
      {description ? (
        <DialogPrimitive.Description
          className="goat-arrive mt-1.5 text-sm leading-6 text-pretty text-muted-foreground [word-break:keep-all]"
          style={arrive(80)}
        >
          {description}
        </DialogPrimitive.Description>
      ) : null}
    </div>
  );
}

export function OnboardingBody({ children }: { readonly children: ReactNode }) {
  return (
    <ScrollArea scrollFade>
      <div className="space-y-3 px-6 pt-5 text-sm">{children}</div>
    </ScrollArea>
  );
}

/**
 * Actions on the right, and where the answer can be changed later on the left. A hint too long
 * to sit beside the actions wraps onto its own line above them.
 */
export function OnboardingFooter({
  hint,
  children,
}: {
  readonly hint?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex flex-col-reverse gap-3 px-6 pt-6 pb-6 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">
      {hint ? (
        <p className="flex min-w-0 items-start gap-1.5 text-xs leading-5 text-muted-foreground max-sm:justify-center sm:flex-[1_1_12rem]">
          <SettingsIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span className="[word-break:keep-all]">{hint}</span>
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:ms-auto sm:shrink-0 sm:flex-row">
        {children}
      </div>
    </div>
  );
}

export function OnboardingOptions({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className="divide-y divide-border/70 overflow-hidden rounded-xl bg-foreground/[0.025] ring-1 ring-border/70 ring-inset dark:bg-white/[0.03]"
    >
      {children}
    </div>
  );
}

export function OnboardingOption({
  title,
  description,
  control,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly control: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? (
          <p className="mt-0.5 text-xs leading-5 text-muted-foreground [word-break:keep-all]">
            {description}
          </p>
        ) : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
