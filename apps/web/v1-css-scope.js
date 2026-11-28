// postcss-prefix-selector transform for the v1 CSS (devlog 070 Revision A2.3): runs after @tailwindcss/postcss, only on
// files under src/v1 (v1 index.css with Tailwind inlined, and the seam rules in seam/v1-entry.css).
//   :root / :host               -> [data-v1]                    (tokens, color-scheme, preflight font and line-height
//                                                                live on every v1 boundary; same specificity as :root)
//   html / body                 -> [data-v1-body]               (v1's page rules: height 100%, overflow hidden,
//                                                                position relative, min-height 100svh, grain. Opt-in
//                                                                for a full-page v1 surface only; on an inline boundary
//                                                                or the portal root they would clip popups)
//   every other top-level rule  -> :where([data-v1]) <selector> (preflight AND utilities stay inside the boundary)
//   rules already led by [data-v1 (seam CSS) -> unchanged
// Class rules are scoped too: v1 index.css uses @theme inline, so utilities carry literal values (text-work-log is
// font-size 0.78125rem) and would style a GOAT 2 element with the same class. :where() adds no specificity, so v1's own
// cascade is unchanged. .dark variants are scoped like any class and never activate (GOAT 2 never sets .dark).
// Nested rules (native CSS nesting inside a rule) are left alone; their parent was already scoped.
// @keyframes / @font-face / @property stay global (postcss-prefix-selector skips keyframes; the others carry no selector).
const ROOT = /^(:root|:host)(?![\w-])/;
const PAGE = /^(html|body)(?![\w-])/;

/** @param {string} prefix @param {string} selector @param {string} _prefixed @param {string} _file @param {import("postcss").Rule} rule */
export function scopeV1Selector(prefix, selector, _prefixed, _file, rule) {
  for (let p = rule?.parent; p; p = p.parent) if (p.type === "rule") return selector;
  const s = selector.trim();
  const root = s.match(ROOT);
  if (root) return prefix + s.slice(root[1].length);
  const page = s.match(PAGE);
  if (page) return `${prefix}-body${s.slice(page[1].length)}`.replace(/^\[data-v1\]-body/, "[data-v1-body]");
  if (s.startsWith("&") || s.startsWith(prefix.slice(0, -1))) return s;
  return `:where(${prefix}) ${s}`;
}
