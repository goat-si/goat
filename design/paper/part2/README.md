# Part 2 Paper boards: providers UI (lane P2-M)

Paper file `01M8GDWPDQSBBWW8RMTG12PGCC`, page **"Part 2 · 제공사"** (`p-7-1`). Drawn 2026-11-28 from GOAT v1 source
(`goat-si/goat` `origin/dev` `916b5ccc1b2`) only: no screenshots, no running app. Frame = GOAT 2 frame cloned from
2R-1 (40px top bar `1BV9-0`, 44px rail `1BWS-0`; workspace rule: flush bottom/right, both left corners 14px, border
top+left 0.5px #E2E2E2). Colors from v1 `apps/web/src/index.css` light tokens.

| Board | Paper id | v1 source |
|---|---|---|
| P1 Settings › Providers list | `1PBB-2` | `routes/_chat.settings.providers.tsx`, `settings/ProviderSettingsPanel.tsx`, `ProviderInstanceCard.tsx`, `settingsNav.ts`, `providerDriverMeta.ts` |
| P2 Provider sign-in (Antigravity) | `1Q0P-2` | `settings/ProviderAuthenticationSection.tsx`, ACP registry URL auth action |
| P3 Add provider › ACP Registry | `1QAN-2` | `settings/AddProviderInstanceDialog.tsx`, `AcpRegistrySearchStep.tsx` |
| P4 Composer model picker | `1QM8-2` | `chat/ProviderModelPicker.tsx`, `ModelPickerContent.tsx`, `ModelPickerSidebar.tsx` |
| P5 Bot settings model picker | `1QYE-2` | `goatBot/GoatBotModelPicker.tsx` (wraps ProviderModelPicker), `routes/_chat.settings.goat-bot.tsx` |

Provider logos are the real v1 marks, copied verbatim: Codex/Claude/Antigravity from `apps/web/src/components/Icons.tsx`
(`OpenAI` path black, `ClaudeAI` path #d97757, `AntigravityIcon` embedded PNG), Grok/fx/Muse/OpenCode/Pi/OmO/Cursor
from each package's `client.ts` `icon` (`packages/provider-*/src/client.ts`, `provider-pi/src/omoClient.ts`; light
fills and gradients as `ProviderPackageIcon` renders them), ACP Registry agents (Kimi Code, Kilo, Kiro CLI, Qwen Code)
from the official CDN icons v1 loads (`officialAcpRegistryIconUrlForAgentId`, `cdn.agentclientprotocol.com/registry/v1/latest/<id>.svg`,
currentColor drawn as #0d0d0d). Registry names/versions/descriptions match the live registry index on 2026-11-28
(DeepSeek is not in it, so P1/P2 show Kilo instead). Settings nav labels are v1's `SETTINGS_SECTION_LABELS`
(`settings/settingsSearch.ts`: e.g. "SnapShots", "Project", "Archived Threads", "Decision Inbox") under the
`settingsNav.ts` groups.

Remaining: model names and account states are placeholder data. P2-M lifts v1 components directly; these boards are
the visual check.

## Matched to v1 per P2-M report (2026-11-29)
Lane P2-M lifted the real v1 components and listed where these boards differed; v1 code wins.
- P1 1PBB-2: rebuilt as v1's list + detail split (ProviderSettingsPanel): rows = logo, name, v1 state line
  ("Authenticated · ChatGPT Pro", "Not found · grok was not found on PATH", "Unavailable · Runtime target missing"),
  enable toggle; actions (Sign in, Reset, Remove) in the detail pane. v1 order incl. Cursor Cloud, Claude Cloud, Devin
  Cloud shown off with "Cloud providers come in a later GOAT 2 release." Label "Muse Code". Settings nav: v1 icons,
  Search on top, no "Settings" title, Memory and Project hidden (v1 availability rules). Devin logo from
  packages/provider-devin-cloud/src/client.ts.
- P3 1QAN-2: registry rows show Added/Add only (no versions, no progress bar).
- P4 1QM8-2 / P5 1QYE-2: trigger "6.1 Sol" (no "gpt-", no chevron); model rows show names (GPT-6.1 Sol, GPT-6.1 Terra,
  GPT-6 Luna) without description; GOAT Bot page keeps only the Model row.
Still differs from v1 (not redrawn yet): P2's URL inside v1's Status card with "Continue authentication"; P3's 4-step
wizard header (Provider / Identity / Config / Set up), built-in provider grid and local presets (Oh My Pi, MiniMax Code),
"Search agents…" copy and Kiro id "kiro"; P4/P5 favorites tab on the rail and greyed-out unsigned providers.

### Matched to v1, round 2 (2026-11-29)
All points from the P2-M report are now drawn from v1 `916b5ccc` source:
- P1 `1PBB-2`: settings nav icons are the real v1 Solar Linear glyphs from `SettingsSidebarNav.tsx`
  `SETTINGS_SECTION_ICONS` (`solar.generated.ts` path data verbatim: tuning2, palette, keyboard, objectScan, testTube,
  ghost, blocks, gitBranch, ssdRound, archive, chatRound, inbox, calendarMark, server, plugCircle; search = magnifer).
- P2 `1Q0P-2`: same list + detail as P1 with Antigravity selected. Status card carries v1's URL auth action
  (`ProviderInstanceCard.tsx:1170-1194`: agent message, the URL in mono, outline "Continue authentication" with the
  external-link glyph). Account row in the waiting state (`ProviderAuthenticationSection.tsx`): "Finish signing in in
  your browser." with Open browser, copy-link icon button and Cancel.
- P3 `1QAN-2`: v1 `AddProviderInstanceDialog` step 0: header "Add provider" / "Add an account or configure a provider
  on This Mac.", step bar Provider / Identity / Config / Set up (`ADD_PROVIDER_WIZARD_STEPS`), built-in provider grid in
  two columns with setup badges (Signed in / Installed / Not installed) and the checked radio, "Or choose from ACP
  Registry", the two local presets from `provider-acp-registry/src/localPresets.ts` (Oh My Pi, MiniMax Code: their inline
  icons, install hints, Documentation, "Use …"), then `AcpRegistrySearchStep` (search field, rows Added / Add; Kiro
  CLI's registry id is `kiro`), footer Cancel / Configure manually / Next. Behind it the new P1 list + detail. Cloud
  kinds are left out of the grid (Part 3).
- P4 `1QM8-2` / P5 `1QYE-2`: picker rail starts with the Favorites tab (filled Solar star) and a divider
  (`ModelPickerSidebar.tsx:105-133`); providers that are not ready are at 50% opacity (`:159-161`) instead of status dots;
  the add button is the Solar plus.
Placeholder data only: model names, versions, account states.
