import { useGT } from "gt-react";
import { RedactedSensitiveText } from "./RedactedSensitiveText";

export function ProviderAuthEmail(props: {
  readonly email: string | undefined;
  readonly className?: string;
}) {
  const gt = useGT();
  const email = props.email?.trim();
  if (!email) return null;

  return (
    <RedactedSensitiveText
      key={email}
      value={email}
      ariaLabel={gt("Toggle account email visibility")}
      revealTooltip={gt("Click to reveal email")}
      hideTooltip={gt("Click to hide email")}
      className={props.className}
    />
  );
}
