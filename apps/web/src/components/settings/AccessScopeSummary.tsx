import { useGT } from "gt-react";
import { AuthHubProxyScope, type AuthEnvironmentScope } from "@goat/contracts";

import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/** A pairing link's or client's scope count, and whether it can open the hub's devices. */
export function AccessScopeSummary({
  scopes,
  label,
}: {
  readonly scopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly label: string;
}) {
  const gt = useGT();
  const scopeCountLabel = gt("{count, plural, one {# scope} other {# scopes}}", {
    count: scopes.length,
  });

  return (
    <>
      <Popover>
        <PopoverTrigger
          openOnHover
          delay={250}
          closeDelay={100}
          render={
            <button
              type="button"
              aria-label={gt("{label}: show {scopes}", { label, scopes: scopeCountLabel })}
              className="cursor-help underline decoration-border underline-offset-2 outline-hidden hover:text-foreground focus-visible:text-foreground"
            />
          }
        >
          {scopeCountLabel}
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          align="start"
          tooltipStyle
          className="w-max max-w-80 whitespace-normal"
        >
          <p className="mb-1 font-medium">{gt("Granted scopes")}</p>
          <div className="flex flex-col gap-0.5">
            {scopes.map((scope) => (
              <code key={scope} className="font-mono text-foreground/85">
                {scope}
              </code>
            ))}
          </div>
        </PopoverPopup>
      </Popover>
      {scopes.includes(AuthHubProxyScope) ? (
        <>
          <span aria-hidden> · </span>
          <span className="text-foreground">{gt("Hub access")}</span>
        </>
      ) : null}
    </>
  );
}
