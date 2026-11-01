import { expect, it } from "vite-plus/test";

import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "./workspaceTitlebar";

it("adds the collapsed brand width only to the collapsed inset", () => {
  const [collapsed, expanded] = COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS.split(" ");
  expect(collapsed).toBe(
    "[[data-sidebar-state=collapsed]_&]:pl-[calc(var(--workspace-titlebar-content-left)+var(--workspace-collapsed-brand-inline-size,0px))]",
  );
  expect(expanded).toBe(
    "max-md:[[data-sidebar-state=expanded]_&]:pl-[var(--workspace-titlebar-content-left)]",
  );
});
