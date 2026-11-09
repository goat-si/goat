/** A work panel tab with nothing in it: what is missing, then how it gets there. */
export function GoatBotPanelEmpty({
  title,
  next,
}: {
  readonly title: string;
  readonly next: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-muted-foreground">{next}</p>
    </div>
  );
}
