// The [data-v1] boundary every lifted v1 surface renders inside: v1 tokens, base text and preflight apply only here
// (postcss.config.js). Portals without a container go to the matching [data-v1-portal] root (seam/base-ui).
import type { HTMLAttributes } from "react";
import "./v1-entry.css";

export function V1Boundary(props: HTMLAttributes<HTMLDivElement>) {
  return <div data-v1="" {...props} />;
}
