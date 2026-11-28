# GOAT 2 providers: v1 capability inventory (features to keep; look is redesigned)

Source: GOAT v1 `origin/dev` 916b5ccc1b2. v1 is the source for FEATURES and facts, not for layout.

| # | Capability | v1 source | GOAT 2 board |
|---|---|---|---|
| 1 | List every provider account (one row per instance; several instances per kind allowed) | ProviderSettingsPanel.tsx | P1 |
| 2 | Per-row state: authenticated / not authenticated / not found on PATH / unavailable / limited / incompatible / unsupported / disabled | ProviderSettingsPanel, ProviderInstanceCard | P1 |
| 3 | Version of the installed CLI | ProviderInstanceCard | P1 |
| 4 | Enable / disable a provider instance | ProviderSettingsPanel | P1 |
| 5 | Refresh provider status + "Checked …" time + periodic health check | ProviderSettingsPanel ("Refresh provider status", health check interval) | P1 |
| 6 | Display name (instance label) and accent color marker shown in the picker | ProviderInstanceCard, AddProviderInstanceDialog | P1 (Details) |
| 7 | Device / environment that runs the provider (This Mac or another connected device) | ProviderSettingsPanel ("Devices", "Device unavailable") | P1, P7 |
| 8 | Account: "Signed in as …", Change account, Sign out | ProviderAuthenticationSection | P1, P2 |
| 9 | Sign-in methods discovery ("Sign-in method", provider default) | ProviderAuthenticationSection | P2 |
| 10 | Browser sign-in: Open browser, Copy sign-in link, Cancel, "Finish signing in in your browser." | ProviderAuthenticationSection | P2 |
| 11 | Device-code sign-in | providerSetup.ts (deviceCode) | P2 (method) |
| 12 | Terminal sign-in (embedded sign-in terminal) | ProviderAuthenticationSection ("Complete sign-in in the terminal below.") | P2 (method) |
| 13 | Credentials sign-in (API key) | ProviderAuthenticationSection ("Enter your credentials below.") | P2 (method) |
| 14 | Sign-in failure / expired request + Retry sign-in / Retry connection | ProviderAuthenticationSection, ProviderSettingsPanel | P2, P7 |
| 15 | ACP registry URL auth ("Continue authentication", accept/decline) | ProviderInstanceCard, providerSetup.ts | P2 |
| 16 | Install a missing CLI (managed install or "Copy command") | ProviderInstanceCard, providerSetup.ts install phases | P7 |
| 17 | Update ("Update now", "Copy update command", "Updating") | ProviderInstanceCard | P7 |
| 18 | Repair (runtime target missing -> reinstall) | ProviderInstanceCard (Unavailable) | P7 |
| 19 | Runtime fields: binary path, home path (CODEX_HOME etc.), shadow home | ProviderInstanceCard "Runtime" | P1 (Details) |
| 20 | Environment variables per instance (plain / sensitive stored separately, Add variable) | ProviderInstanceCard "Variables" | P1 (Details) |
| 21 | Project override of a setting + "Reset to the device setting" | ProviderInstanceCard | P1 (Details) |
| 22 | Models list of the instance | ProviderInstanceCard "Models" | P1 |
| 23 | Delete / reset an instance (incl. "managed files remain" warning) | ProviderSettingsPanel | P1 (… menu) |
| 24 | Add provider: built-in kinds with setup badges (Signed in / Installed / Not installed / Beta) | AddProviderInstanceDialog | P3 |
| 25 | Add provider: local presets (Oh My Pi, MiniMax Code) with install command + docs | localPresets.ts, AddProviderInstanceDialog.presets | P3 |
| 26 | Add provider: ACP Registry search, prepare/download, "Already added", no results | AcpRegistrySearchStep | P3 |
| 27 | Add provider manually (Local ACP command, executable, instance id) | AddProviderInstanceDialog ("Configure manually") | P3 |
| 28 | Multi-account guidance (separate accounts, limits not pooled) | AddProviderInstanceDialog callout | P7 |
| 29 | Cloud counterparts (Cursor Cloud, Claude Cloud) and cloud platforms (Devin Cloud) | providerDriverMeta.ts | P6 |
| 30 | Permissions: limited permissions for this session | ProviderSettingsPanel ("Limited permissions") | P7 |
| 31 | Empty: "No providers configured." | ProviderSettingsPanel | P8 |
| 32 | Composer model picker: compact trigger, provider rail, Favorites, model list, search | ProviderModelPicker, ModelPickerSidebar, ModelPickerContent | P4 |
| 33 | Picker: not-ready / limited / unavailable providers marked; Add provider from picker | ModelPickerSidebar | P4 |
| 34 | Reasoning effort / service tier options next to the model | ModelPickerContent | P4 |
| 35 | Bot model picker (same picker on the bot's settings) | GoatBotModelPicker | P5 |
