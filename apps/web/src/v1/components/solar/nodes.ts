/**
 * Solar Linear glyph data for code that draws icons itself (context menus, injected markup).
 * React call sites import components from `~/components/solar` instead.
 */
import type { IconNode } from "./iconNode";
import * as solar from "./solar.generated";

export const Box = solar.box;

/** Context menu glyphs keyed by the icon names that `ContextMenuItem.icon` carries. */
export const CONTEXT_MENU_ICONS: Readonly<Record<string, IconNode>> = {
  archive: solar.archive,
  check: solar.check,
  "arrow-up-from-line": solar.arrowUpFromLine,
  timer: solar.stopwatch,
  "chevron-right": solar.altArrowRight,
  "circle-check": solar.checkCircle,
  clock: solar.clockCircle,
  pencil: solar.pen,
  copy: solar.copy,
  folder: solar.folder,
  "git-branch": solar.gitBranch,
  "git-fork": solar.gitFork,
  hash: solar.hashtag,
  "mail-open": solar.letterOpened,
  "message-square-plus": solar.chatRoundAdd,
  pin: solar.pin,
  "pin-off": solar.pin,
  "refresh-cw": solar.refresh,
  settings: solar.settings,
  "folder-plus": solar.addFolder,
  "folder-tree": solar.folderTree,
  "text-search": solar.fileSearch,
  trash: solar.trashBinMinimalistic,
};

/** Static SVG markup for surfaces that inject HTML, such as inline composer chips. */
export function iconSvgMarkup(node: IconNode): string {
  const children = node
    .map(([tag, attrs]) => {
      const attributes = Object.entries(attrs)
        .map(([name, value]) => " " + name + '="' + value + '"')
        .join("");
      return "<" + tag + attributes + "/>";
    })
    .join("");
  return (
    '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" stroke="currentColor">' +
    children +
    "</svg>"
  );
}
