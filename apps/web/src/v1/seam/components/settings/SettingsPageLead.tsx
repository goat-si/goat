// Seam for v1 apps/web/src/components/settings/SettingsPageLead.tsx (goat 916b5ccc1b2). v1 picks the lead from the
// router path; GOAT 2 has one settings page here, so the providers lead is fixed. Markup and the first sentence of
// the text are v1's (settingsNav.ts:67-72); the OpenCodex Home sentence and Hub link are v1-only and dropped.
export function SettingsPageLead() {
  return (
    <>
      <h1 className="sr-only">Providers</h1>
      <p className="max-w-[80ch] px-3 text-sm text-pretty text-muted-foreground sm:px-4">
        The coding agents GOAT runs, with their accounts and models.
      </p>
    </>
  );
}
