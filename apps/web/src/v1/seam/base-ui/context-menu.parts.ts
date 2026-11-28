// Bridge (docs/PROVENANCE.md): @base-ui/react/context-menu parts with Portal mounted into the v1 portal root. The real package
// is imported by its file path so the alias map (which points @base-ui/react/context-menu here) cannot recurse.
import { createElement, type ComponentProps } from "react";
import { Portal as RealPortal } from "../../../../node_modules/@base-ui/react/context-menu/index.parts.mjs";
import { withV1Container } from "./portalRoot.ts";

export * from "../../../../node_modules/@base-ui/react/context-menu/index.parts.mjs";
export function Portal(props: ComponentProps<typeof RealPortal>) {
  return createElement(RealPortal, withV1Container(props));
}
export declare namespace Portal {
  type Props = RealPortal.Props;
  type State = RealPortal.State;
}
