// Seam for v1 apps/web/src/components/settings/SettingsPageLead.tsx (goat 916b5ccc1b2). v1 picks the lead from the
// router path (settingsNav.ts SETTINGS_PAGE_LEADS); GOAT 2's settings frame sets that path through the router seam.
// Markup and the first sentence of each text are v1's (settingsNav.ts:67-72, 89-93); the sentences about v1-only
// features (OpenCodex Home, the hub link, the "Runs on" environment picker) are dropped.
import { useLocation } from "@tanstack/react-router";

const LEADS: Readonly<Record<string, { readonly title: string; readonly text: string }>> = {
  "/settings/providers": { title: "Providers", text: "The coding agents GOAT runs, with their accounts and models." },
  "/settings/goat-bot": { title: "GOAT Bot", text: "GOAT Bot answers your messages and starts work for you." },
};

export function SettingsPageLead() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const lead = LEADS[pathname];
  if (!lead) return null;
  return (
    <>
      <h1 className="sr-only">{lead.title}</h1>
      <p className="max-w-[80ch] px-3 text-sm text-pretty text-muted-foreground sm:px-4">{lead.text}</p>
    </>
  );
}
