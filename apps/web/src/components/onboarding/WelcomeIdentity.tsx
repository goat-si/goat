import { GoatWordmark } from "../GoatWordmark";

export function WelcomeIdentity() {
  return (
    <div className="flex items-center gap-2" role="img" aria-label="GOAT">
      <GoatWordmark className="size-6 shrink-0" aria-hidden />
      <span className="text-2xl font-medium tracking-tight">GOAT</span>
    </div>
  );
}
