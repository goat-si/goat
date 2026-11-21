import { expect, it } from "vite-plus/test";
import { applyThemeCss } from "./themeCss";

it.each([
  '@import "https://evil.example/x.css";',
  '[data-slot="sidebar"]{background:url(https://evil.example/x)}',
  '[data-slot="sidebar"]{background:image-set("https://evil.example/x" 1x)}',
  '[data-slot="sidebar"]{background:-webkit-image-set("https://evil.example/x" 1x)}',
  '[data-slot="sidebar"]{background:image("https://evil.example/x")}',
  '[data-slot="sidebar"]{background:cross-fade(url(https://evil.example/x),red)}',
  '[data-slot="sidebar"]{background:element(#x)}',
  '[data-slot="sidebar"]{background:src("https://evil.example/x")}',
  '[data-slot="sidebar"]{background:"https://evil.example/x"}',
])("rejects CSS resource loading on the client", async (css) => {
  await expect(applyThemeCss(css)).rejects.toThrow("Images in theme CSS are not supported");
});

it("applies safe CSS only within the theme root and removes it on reset", async () => {
  const root = document.createElement("div");
  root.setAttribute("data-goat-theme-root", "");
  const sidebar = document.createElement("div");
  sidebar.setAttribute("data-slot", "sidebar");
  root.append(sidebar);
  document.body.append(root);
  try {
    await applyThemeCss('[data-slot="sidebar"]{color:rgb(1,2,3)}');
    expect(getComputedStyle(sidebar).color).toBe("rgb(1, 2, 3)");
    await applyThemeCss(undefined);
    expect(getComputedStyle(sidebar).color).not.toBe("rgb(1, 2, 3)");
  } finally {
    root.remove();
    await applyThemeCss(undefined);
  }
});

it("clears prior styling and rejects unsafe CSS", async () => {
  await applyThemeCss('[data-slot="sidebar"]{color:red}');
  await expect(applyThemeCss('@import "https://evil.example/x.css";')).rejects.toThrow();
  const root = document.createElement("div");
  root.setAttribute("data-goat-theme-root", "");
  const sidebar = document.createElement("div");
  sidebar.setAttribute("data-slot", "sidebar");
  root.append(sidebar);
  document.body.append(root);
  try {
    expect(getComputedStyle(sidebar).color).not.toBe("rgb(255, 0, 0)");
  } finally {
    root.remove();
    await applyThemeCss(undefined);
  }
});
