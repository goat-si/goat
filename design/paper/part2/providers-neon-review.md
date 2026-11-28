### 1. UX Principles
1. **One frame, zero nesting:** Mirror Machines (`44px` rail, `256px` `#F7F7F7` sidebar, white main pane, hairline sections). Never stack modals or bordered cards.
2. **Outcome over plumbing:** Speak in owner terms (“Ready”, “Needs sign-in”, “Installs automatically”), not CLI jargon (`PATH`, `ACP Registry`, `CODEX_HOME`).
3. **Every state names its next action:** Replace passive errors (“not found on PATH”) with an action (`Install`, `Sign in`, `Update`, `Reinstall`, `Retry`).
4. **Status is the only color:** Keep chrome monochrome; reserve colored dots strictly for live health.
5. **Progressive disclosure with truth on the cover:** Hide paths, env vars, and overrides inside one collapsed `> Details` row whose summary still surfaces active counts.
6. **Default to one-click, escape hatch to manual:** Show each provider’s default auth/install method first; tuck alternates (`Copy command`, terminal sign-in, custom CLI) one click deeper.
7. **List only what you use:** Unadded cloud providers and unconfigured CLIs stay in the catalog, not the sidebar.
8. **Pickers pick, workspaces configure:** Keep model pickers fast and compact; hand off setup/sign-in to Providers.

---

### 2. Visible vs. Hidden by Screen (all 35 v1 capabilities)

- **P1 List + Detail**
  - *Visible:* Sidebar = search, account rows (logo, name/account label, 1-line state, 1 status dot; no row toggles), bottom `+ Add a provider`. Header = logo, name, status dot + CLI version + `Checked …` + refresh, Enable/Disable switch, `⋯` (`Reset` / `Delete` with “managed files remain” warning). Sections = issue banner (if any), `Account`, `Models`, `Runs on` (machine + health), `Also run in <X> Cloud` (when applicable), collapsed `> Details` summary.
  - *Hidden (`Details`):* Display name/label edit, binary/home/shadow paths, plain/sensitive env vars (`+ Add`), project overrides + `Reset to device setting`.
- **P2 Sign-in**
  - *Visible:* Inline inside P1 `Account`—default method only (browser `Open browser`/`Copy link`/`Cancel`, device code, API key, or ACP URL `Continue authentication` accept/decline) plus inline expired/failure state with `Retry sign-in`.
  - *Hidden:* Alternate methods under `Use another method`; embedded sign-in terminal expands only if chosen/required.
- **P3 Add / Catalog**
  - *Visible:* Main-pane view (like `Add a machine`) with search, filter (`All`, `Ready on this Mac`, `Cloud`), one unified list (logo, name, plain readiness badge, `Add`/`Install & add`/`Already added`), and no-results state.
  - *Hidden:* Source taxonomy, raw `curl`/`npm` commands, docs links (in row info/step 2), and `Add custom CLI…` (footer link for manual executable/command/ID).
- **P4 Composer Picker**
  - *Visible:* Compact trigger; popover with search, `Favorites`, provider rail (status dots; greyed rows with `Sign in`/`Fix`), models + inline reasoning effort/service tier, footer `+ Add provider`.
  - *Hidden:* Auth forms, CLI versions, env/path settings, disabled instances.
- **P5 Bot Model**
  - *Visible:* Same P4 picker in Bot settings; ready providers first, inline `Fix in Providers` if current selection is broken.
  - *Hidden:* Account creation, install, and provider configuration.
- **P6 Cloud Opt-in**
  - *Visible:* `Also run in <X> Cloud` toggle inside the local provider’s P1 detail; pure cloud (`Devin Cloud`) and cloud-only options searchable in P3 (`Cloud` filter).
  - *Hidden:* Unadded cloud entries in P1 sidebar and P4 picker.
- **P7 Install / Update / Repair + Multi-account**
  - *Visible:* Top banner when ≥1 provider needs update (`Update all`); inline state banner for install, `Update now`/`Updating`, repair (`Reinstall`), `Retry connection` (device unavailable), or limited permissions; `Add another account` in `Account` with 1-line “separate limits, not pooled” note.
  - *Hidden:* `Copy command`/`Copy update command` as secondary actions; install logs behind `Show details`.
- **P8 First-run / Empty**
  - *Visible:* Centered “No providers yet” + auto-detected CLIs on this Mac with 1-click `Add`, plus `Browse catalog` (opens P3).
  - *Hidden:* Empty detail chrome, `Details` drawer, cloud promos.

---

### 3. Concrete Fixes

- **Nesting fix:** Promote Providers out of Settings into a top-level rail view matching Machines. Delete the settings card, inner sub-cards, sidebar switches, and 4-step wizard modal. Use flat hairline sections, one bottom `> Details` bar, and swap the main pane in-place for `+ Add a provider`.
- **Preset / Registry split fix:** Merge built-ins, local presets (Oh My Pi, MiniMax Code), and ACP Registry into **one catalog index** ordered `Detected on this Mac` → `Popular` → `More` (live registry query on search). Replace source badges with action-oriented badges (`Signed in`, `Installed`, `1-click install`, `Needs setup`, `Cloud`) and run prepare/download inline in the main pane. Keep manual ACP setup as one footer link (`Add custom CLI…`).

---

### 4. Risks in Your Direction

1. **Source tags + install methods in P3 hurt non-developers:** Tagging “Built-in / Preset / ACP Registry” and showing shell commands exposes plumbing. Show *effort/outcome* instead; reveal commands only when manual install is needed.
2. **Cloud-only dead end:** Putting Cursor/Claude Cloud *only* inside local provider details blocks owners who want Claude Cloud without installing the local CLI. Keep them out of P1 by default, but searchable in P3 under `Cloud`.
3. **Flat sidebar breaks at multi-account + multi-machine:** Two Codex accounts across two Macs look identical. Put `account · machine · state` in the subtitle and soft-group by machine (like Machines’ sidebar) once >1 machine is active.
4. **Inline `Sign in` inside P4 popover traps users:** Device-code, API keys, and terminal auth don’t fit a compact picker. Route `Sign in` to P2 (or trigger 1-click browser OAuth and return focus).
5. **House-style clash on v1 accent color markers (#6):** Colored account dots next to status dots break “color only for status.” Differentiate accounts with short text labels (`Codex · Work`) instead.
6. **Invisible overrides in collapsed `Details`:** Always print active counts on the collapsed bar (`2 project overrides · 3 variables`) so hidden overrides don’t cause mysterious behavior.
