import { Tabs as TabsPrimitive } from "@base-ui/react/tabs";

import { cn } from "~/lib/utils";

/**
 * In-page tabs that switch whole panels. They look like the segmented toggle group, but carry
 * tab semantics (`tablist`, `aria-selected`, arrow keys, linked panels) for that job.
 */
function Tabs({ className, ...props }: TabsPrimitive.Root.Props) {
  return (
    <TabsPrimitive.Root className={cn("flex flex-col", className)} data-slot="tabs" {...props} />
  );
}

const LIST_VARIANTS = {
  default: "flex gap-0.5 rounded-lg bg-input/40 p-0.5",
  // Bare text tabs on the surface itself; only the chosen one gets a soft pill.
  plain: "flex gap-1",
} as const;

function TabsList({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.List.Props & { variant?: keyof typeof LIST_VARIANTS }) {
  return (
    <TabsPrimitive.List
      className={cn(LIST_VARIANTS[variant], className)}
      data-slot="tabs-list"
      {...props}
    />
  );
}

const TAB_VARIANTS = {
  default: "h-7 gap-1.5 px-2.5 text-xs",
  // An icon over a short label, so several destinations share a narrow row without scrolling.
  stacked: "h-auto flex-col gap-0.5 px-0.5 py-1.5 text-[0.6875rem] leading-none [&_svg]:size-4",
  // For a plain list: a text label whose pill appears only when chosen.
  plain:
    "h-7 flex-none px-3 text-sm data-active:bg-input/60 data-active:shadow-none dark:data-active:bg-input/60",
} as const;

function TabsTab({
  className,
  variant = "default",
  ...props
}: TabsPrimitive.Tab.Props & { variant?: keyof typeof TAB_VARIANTS }) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "inline-flex min-w-0 flex-1 cursor-pointer select-none items-center justify-center whitespace-nowrap rounded-md font-medium text-muted-foreground outline-none transition-colors hover:bg-background/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-active:bg-background data-active:text-foreground data-active:shadow-xs/10 dark:hover:bg-input/32 dark:data-active:bg-input/72",
        TAB_VARIANTS[variant],
        className,
      )}
      data-slot="tabs-tab"
      {...props}
    />
  );
}

function TabsPanel({ className, ...props }: TabsPrimitive.Panel.Props) {
  return (
    <TabsPrimitive.Panel
      className={cn(
        "outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        className,
      )}
      data-slot="tabs-panel"
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsPanel, TabsTab };
