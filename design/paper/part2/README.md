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

## Boards generated from the rendered v1 components (2026-11-29)

P1-P5 (`1PBB-2`, `1Q0P-2`, `1QAN-2`, `1QM8-2`, `1QYE-2`) are no longer hand-drawn. They are generated from P2-M's
rendered v1 components at `goat2_providers_ui` **`145728d88f7`**: the web app runs on the fake host
(`?fake=<board id>`, plus the same clicks as `apps/web/e2e/providers.spec.ts`), a headless browser serializes the
DOM with computed styles inlined (colors resolved to hex, grids and portals flattened to absolute layers, scroll
offsets applied, system font stack), and the HTML replaces the board content in Paper (board ids kept). Script:
`scripts/paper/render-v1-boards.mjs`. Regenerate this way after P2-M changes instead of redrawing.

Pixel difference vs the browser screenshot (threshold 48/255): P1 2.4%, P2 3.3%, P3 0.6%, P4 0.8%, P5 0.6%.
Known gaps: v1's privacy blur on emails is not reproduced (the fake host's scrambled placeholder shows); on P2 the
providers card sits ~58px further left than in the browser; the Antigravity PNG logo and a few toggle thumbs render
slightly differently. Data is the fake host's placeholder data.
