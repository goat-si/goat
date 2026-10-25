# GOAT marketing site design

This file records the direction, tokens and rules for `apps/marketing`. Read it before changing the
site's look, copy or structure. When a decision here changes, rewrite the affected section.

## Reading

The site is a product landing page for developers who already run coding agents and now want them on
more than one machine. They judge GOAT by what it really does, so the page leads with the real app
and plain statements of shipped behavior. The brand is quiet: a white horns-and-chevron mark on
zinc, a neutral app with one blue accent. The site follows that, so the first impression matches the
app people install.

Do: show real app captures, name real providers and real setup paths, link every claim to a guide.
Don't: invent numbers, testimonials, pricing, demos, security properties or legal facts; decorate with
gradients, glow, fake dashboards or icon tiles.

## Direction

Three concepts were compared (boards are in the design pull request):

- **Control room.** Dark, left-aligned headline, a full-width app capture that runs off the right
  edge, a line diagram of machines and clients, a two-column feature list on hairlines.
- **Field manual.** Light editorial page with framed figures and one task followed from a laptop to
  an SSH host to a phone.
- **Split surfaces.** Sections alternate light and dark to show both app themes, with a desktop and
  phone hero and a language switch.

Chosen: **Control room**, with two parts taken from the others. From Field manual comes the section
that follows one piece of work across machines, the clearest way to explain what GOAT adds over a
single-machine agent app. From Split surfaces comes the EN/KO switch in the header. Alternating
light and dark sections was rejected because it doubles the visual noise. The page follows the
reader's system theme instead, and every capture ships in both themes.

Control room won because the product's core is multi-machine control, and its diagram explains that
faster than prose. The left-aligned hero keeps the headline short and lets the capture carry the
weight.

Dials: variance 5, motion 2, density D3. Motion sits below the usual landing range on purpose:
AGENTS.md treats GPU cost and dropped frames as product defects, so the site animates only hover,
press and focus feedback (150-200 ms), and nothing repaints continuously.

## Tokens

The palette starts from GOAT's default app theme (`GOAT_LIGHT_THEME_COLORS` and
`GOAT_DARK_THEME_COLORS` in `packages/shared/src/themePalettes.ts`). Values marked
(site) are adjustments for contrast; the rest match the app.

| Role               | Light            | Dark             |
| ------------------ | ---------------- | ---------------- |
| Canvas             | `#fcfcfc`        | `#171717`        |
| Raised surface     | `#ffffff`        | `#232323`        |
| Text               | `#18181b` (site) | `#f5f5f5`        |
| Muted text         | `#5f5f68` (site) | `#a1a1a1`        |
| Hairline           | `#e4e4e7`        | `#2e2e2e`        |
| Accent (fills)     | `#1b4ed8`        | `#346bf1`        |
| Accent (link text) | `#1b4ed8`        | `#8eb0ff` (site) |
| Mark tile          | `#18181b`        | `#18181b`        |

The app's muted `#71717b` reaches only 4.7:1 on the canvas and drops below 4.5:1 on light tints,
so the site uses `#5f5f68` (6.2:1). Text uses the mark's `#18181b` instead of the app's
`#27272a`. White on either accent fill is at least 4.65:1, and the dark link color `#8eb0ff` is
lighter than the fill so links on `#171717` clear 4.5:1.

Type: DM Sans (self-hosted, already in the repository) for Latin text. Commands use the platform's
monospace face (`ui-monospace`, SF Mono, Menlo, Consolas), so the site ships one font family.
Korean falls back to the platform's Hangul face (`Apple SD Gothic Neo`, `Pretendard` when installed,
`Malgun Gothic`, `Noto Sans KR`), so the site downloads no CJK font. Korean text uses
`word-break: keep-all`. Headlines are weight 600 with -0.025em tracking and `text-wrap: balance`.
Body copy is 17px at 1.6 line height with a 65ch measure.

Shape: 6px radius on controls, 10px on figures, square diagram nodes. Depth comes from hairlines,
never from a border plus a diffuse shadow on the same element.

## Structure

Every page exists in English at `/` and Korean at `/ko/`, under the deploy's base path (`/goat/`
on GitHub Pages). Every internal link, image `src`/`srcset`, canonical, `hreflang`, Open Graph URL
and manifest field is built from the base path.

| Page     | Purpose                                                                                                       |
| -------- | ------------------------------------------------------------------------------------------------------------- |
| Home     | Hero with capture, environments diagram, work across machines, agents, features, open source, download        |
| Download | Desktop builds per platform from the newest release, the `goat` command, server-only install, mobile status   |
| Legal    | Which GOAT policies are not published yet, what the site itself does with visits, product usage data, license |
| 404      | One page in both languages, since a static host serves a single `404.html` for every missing path             |

`/privacy-policy`, `/terms-of-service` and `/security-policy` stay as routes so links to those
paths on this site keep working; each renders the matching part of the legal page. Links in the app
still point at `t3.codes` (`apps/web/src/legalLinks.ts`, `packages/contracts/src/goatProjectFile.ts`);
moving them is a separate decision. `/schema/t3.json` stays because `goat.json` files name that
path. `/95` (an upstream easter egg) is removed and falls through to the 404 page.

Legal content is honest about gaps. GOAT has not published its own privacy policy, terms or security
contact, so the legal page says so. It never republishes upstream T3 Tools Inc. text, and it never
adopts the upstream contact in `.github/SECURITY.md` as GOAT's. Publishing real policies is a launch
blocker.

## Content rules

- The site loads no analytics script and sets no cookies. Hosting providers still log requests
  (GitHub Pages keeps visitor IP addresses), and the download page calls the GitHub API from the
  reader's browser. Say exactly that; never "we collect nothing".
- Every product claim is traceable to `README.md` or a guide in `docs/user`. Link the guide.
- No metrics, testimonials, logos of customers or star counts.
- `goat-si/goat-releases` publishes stable releases and Nightly builds. Download links use the newest
  stable release and fall back to the newest nightly only when no stable release exists; never label
  a nightly as stable. The install script follows the Nightly train by default.
- The mobile app is not in the App Store or Google Play. The store listings belong to T3 Code.
- Captures come from the real app running demo projects with real agent turns, captioned as demo
  data. No real project, machine name or account appears in them.
- Korean copy is written for Korean readers, not translated word for word. Product names, commands and
  settings paths stay in English, as they appear in the app.

## Budgets

The site sends no analytics, cookies or third-party requests, except the download page asking the
GitHub API for the newest release.

| Budget               | Limit                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------- |
| JavaScript, home     | 0 bytes (no client script)                                                                              |
| JavaScript, download | 4 KB gzip                                                                                               |
| CSS, any page        | 12 KB gzip                                                                                              |
| Fonts                | 80 KB of woff2 per page: DM Sans latin (preloaded), latin-ext only when a page uses those glyphs        |
| Hero capture         | 180 KB at 1280 px wide, 1x (WebP, responsive `srcset`)                                                  |
| Home transfer        | 700 KB on a cold load at 1280x900, 1x                                                                   |
| Lighthouse           | Performance 95+ (desktop preset) and 90+ (default mobile); Accessibility and Best Practices 100         |
| SEO                  | Lighthouse SEO 100 on a launch build; the Pages preview build is `noindex` and checked for that instead |
| Layout shift         | CLS below 0.02                                                                                          |

Measure with the Lighthouse CLI against `astro preview` of the production build, cold cache.

## Accessibility

Contrast AA everywhere, a skip link, visible focus rings on every control, a real `<nav>`,
`<main>`, `<footer>`, one `h1` per page, `lang` and `hreflang` set per locale, alt text that
says what a capture shows, and no information carried by color alone. `prefers-reduced-motion`
removes all transitions. Checked by hand: keyboard-only pass through every page, focus never hidden
under the sticky header, 200% zoom and a 320 px wide viewport without horizontal scrolling, and
touch targets of at least 44 px.
