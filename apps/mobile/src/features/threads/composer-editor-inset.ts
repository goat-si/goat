import { MOBILE_TYPOGRAPHY } from "../../lib/typography";
import type { ScaledTextRole } from "../settings/appearance/useScaledTextRole";

export const COLLAPSED_EDITOR_DEFAULT_INSET = 6;
// iOS puts line-height slack above glyphs. The system font's lowercase midline is
// descender (0.211em) + half x-height (0.526em) above the line bottom.
const LOWERCASE_MIDLINE_EM = 0.474;
function lowercaseMidline(text: ScaledTextRole): number {
  return text.lineHeight - LOWERCASE_MIDLINE_EM * text.fontSize;
}
export function collapsedEditorInset(text: ScaledTextRole): number {
  const shift = lowercaseMidline(text) - lowercaseMidline(MOBILE_TYPOGRAPHY.body);
  return Math.max(0, Math.round(COLLAPSED_EDITOR_DEFAULT_INSET - shift));
}
