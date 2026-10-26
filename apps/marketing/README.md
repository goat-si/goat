# GOAT marketing site

The public site for GOAT, built with Astro as a static site in English (`/`) and Korean (`/ko/`).
Read [DESIGN.md](./DESIGN.md) before changing its look, copy or structure; it records the direction,
tokens, content rules and budgets.

## Run it

From the repository root:

```bash
vp run dev:marketing                       # dev server on port 4173
vp run --filter @goat/marketing build      # static build in apps/marketing/dist
vp run start:marketing                     # serve the build
vp run --filter @goat/marketing typecheck  # astro check
```

The build copies `scripts/install.sh` and `scripts/install.ps1` into `public/` first, so the site
serves the current install scripts.

## Build settings

| Variable              | Default              | Purpose                                                                        |
| --------------------- | -------------------- | ------------------------------------------------------------------------------ |
| `MARKETING_SITE_URL`  | `https://trygoat.ai` | Origin for canonical, `hreflang`, Open Graph and sitemap URLs                  |
| `MARKETING_BASE_PATH` | `/`                  | Path the site is served under, such as `/goat` for a GitHub Pages project site |
| `MARKETING_NOINDEX`   | unset                | `1` adds `noindex` to every page and makes `robots.txt` disallow crawling      |

The GitHub Pages preview builds with `MARKETING_SITE_URL=https://goat-si.github.io`,
`MARKETING_BASE_PATH=/goat` and `MARKETING_NOINDEX=1`. Every internal link goes through
`withBase` or `localePath` in `src/lib/paths.ts`; a hard-coded `/` link breaks under a base path.

## Where things live

- `src/i18n/en.ts` holds every English string and defines the `Messages` type. `src/i18n/ko.ts` must
  match it, so a string added in one language fails the typecheck until the other has it.
- `src/components/` holds one component per page body; `src/pages/` and `src/pages/ko/` only pick
  the locale.
- `src/scripts/releases.ts` is the only client script. It fills the download links from
  `goat-si/goat-releases` and leaves links to the releases page when GitHub cannot be reached.
- `src/pages/robots.txt.ts`, `sitemap.xml.ts` and `site.webmanifest.ts` generate those files with
  the base path applied. `src/pages/schema/goat.json.ts` serves the `goat.json` schema at the URL
  `GOAT_PROJECT_FILE_SCHEMA_URL` names.
- `public/` holds the icons (from `assets/prod`) and the Open Graph images in `public/og/`.

## Product captures

`src/assets/captures/` holds captures of the real app: a demo project called trailhead, a real Codex
turn, and the resulting diff, in each language and theme, at 1440x900 and 390x844 (both at 2x). To
refresh them:

1. Start an isolated dev server with no seeded data, for example
   `vp run dev --home-dir <empty dir> --no-seed --auto-bootstrap-project-from-cwd=false`. Use a
   demo machine name: put a `scutil` (macOS) or `hostnamectl` (Linux) script that prints it first on
   `PATH`, and set `SHELL` to a shell that skips your login profile so the server keeps that `PATH`.
2. Create small demo repositories with an `AGENTS.md` that asks for plain replies in the request's
   language, add them as projects, and run a real turn in each.
3. Capture with Playwright at the sizes above, light and dark, with the development channel badge
   hidden, and convert to WebP at quality 90.

Never capture a real project, machine name or account. The Open Graph images in `public/og/` are
1200x630 renders of the dark desktop capture with the page headline.

## Budgets

The site loads no analytics or third-party scripts. Check a change against the budgets in
[DESIGN.md](./DESIGN.md#budgets) with Lighthouse against `vp run start:marketing`.
