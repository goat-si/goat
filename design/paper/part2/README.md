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

Known gaps: provider logos are letter tiles (copy real v1 SVGs before generating code); some settings nav labels
inferred from route names; model names/states are placeholder data. P2-M lifts v1 components directly; these boards
are the visual check.
