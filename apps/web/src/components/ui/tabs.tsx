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

function TabsList({ className, ...props }: TabsPrimitive.List.Props) {
  return (
    <TabsPrimitive.List
      className={cn("flex gap-0.5 rounded-lg bg-input/40 p-0.5", className)}
      data-slot="tabs-list"
      {...props}
    />
  );
}

function TabsTab({ className, ...props }: TabsPrimitive.Tab.Props) {
  return (
    <TabsPrimitive.Tab
      className={cn(
        "inline-flex h-7 min-w-0 flex-1 cursor-pointer select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md px-2.5 font-medium text-muted-foreground text-xs outline-none transition-colors hover:bg-background/55 hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-active:bg-background data-active:text-foreground data-active:shadow-xs/10 dark:hover:bg-input/32 dark:data-active:bg-input/72",
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
