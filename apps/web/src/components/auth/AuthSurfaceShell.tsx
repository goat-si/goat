import type { ReactNode } from "react";

import { APP_STAGE_LABEL } from "../../branding";
import { GoatWordmark } from "../GoatWordmark";
import { BrandChannelPill } from "../sidebar/BrandChannelPill";
import { resolveBrandChannel } from "../sidebar/brandChannel";
import { StandalonePage } from "../ui/standalone-page";

export function AuthSurfaceShell({ children }: { readonly children: ReactNode }) {
  const channel = resolveBrandChannel(APP_STAGE_LABEL);

  return (
    <StandalonePage
      tone="brand"
      masthead={
        <header className="flex h-24 items-center gap-2 bg-background p-5 text-foreground sm:p-6">
          <GoatWordmark aria-hidden className="size-6 shrink-0" />
          <span className="font-brand text-lg font-bold">GOAT</span>
          <BrandChannelPill channel={channel} />
        </header>
      }
    >
      {children}
    </StandalonePage>
  );
}
