//! Local ACP command presets, from v1 `packages/provider-acp-registry/src/localPresets.ts` (all 24
//! lines) at 916b5ccc1b2. Values are verbatim, including the inlined icons.

use super::settings::{RegistrySettings, Source};

/// One local command the ACP dialog offers (v1 `ACP_LOCAL_PRESETS` entry).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LocalPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub command: &'static str,
    pub args: &'static [&'static str],
    pub icon_url: &'static str,
    pub install_hint: &'static str,
    pub docs_url: &'static str,
}

/// v1 `localPresets.ts:1-24`.
pub const ACP_LOCAL_PRESETS: [LocalPreset; 2] = [
    LocalPreset {
        id: "omp",
        label: "Oh My Pi",
        command: "omp",
        args: &["acp", "--approval-mode", "always-ask"],
        // The project icon (oh-my-pi assets/icon.svg) on a dark tile, inlined so the dialog fetches nothing.
        icon_url: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20120%20120%22%3E%3Crect%20width%3D%22120%22%20height%3D%22120%22%20rx%3D%2224%22%20fill%3D%22%230d0d0d%22%2F%3E%3Cg%20transform%3D%22translate(0%2015)%22%3E%3Crect%20x%3D%2210%22%20y%3D%228%22%20width%3D%22100%22%20height%3D%2212%22%20rx%3D%222%22%20fill%3D%22%23fafafa%22%2F%3E%3Crect%20x%3D%2225%22%20y%3D%2220%22%20width%3D%2212%22%20height%3D%2262%22%20rx%3D%222%22%20fill%3D%22%23fafafa%22%2F%3E%3Crect%20x%3D%2275%22%20y%3D%2220%22%20width%3D%2212%22%20height%3D%2245%22%20rx%3D%222%22%20fill%3D%22%23fafafa%22%2F%3E%3Crect%20x%3D%2271%22%20y%3D%2255%22%20width%3D%2220%22%20height%3D%2216%22%20rx%3D%223%22%20fill%3D%22%23f97316%22%2F%3E%3Crect%20x%3D%2276%22%20y%3D%2259%22%20width%3D%223%22%20height%3D%228%22%20rx%3D%221%22%20fill%3D%22%230d0d0d%22%2F%3E%3Crect%20x%3D%2282%22%20y%3D%2259%22%20width%3D%223%22%20height%3D%228%22%20rx%3D%221%22%20fill%3D%22%230d0d0d%22%2F%3E%3C%2Fg%3E%3C%2Fsvg%3E",
        install_hint: "curl -fsSL https://omp.sh/install | sh",
        docs_url: "https://github.com/can1357/oh-my-pi",
    },
    LocalPreset {
        id: "minimax-code",
        label: "MiniMax Code",
        command: "mcode",
        args: &["acp"],
        // MiniMax Code's ACP Registry icon, inlined for locally installed agents.
        icon_url: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20width%3D%2216%22%20height%3D%2216%22%20viewBox%3D%220%200%2016%2016%22%3E%3Cpath%20fill%3D%22currentColor%22%20d%3D%22M2%203h3l3%205%203-5h3v10h-2V6.5l-4%206-4-6V13H2V3Z%22%2F%3E%3C%2Fsvg%3E",
        install_hint: "npm install -g @minimax-ai/code",
        docs_url: "https://github.com/MiniMax-AI/minimax-code",
    },
];

impl LocalPreset {
    pub fn find(id: &str) -> Option<&'static LocalPreset> {
        ACP_LOCAL_PRESETS.iter().find(|preset| preset.id == id)
    }

    /// The local settings the dialog saves for this preset (v1 `localPresets.test.ts:13-17`).
    pub fn settings(&self) -> RegistrySettings {
        RegistrySettings {
            source: Source::Local,
            command_path: self.command.into(),
            command_args: self.args.iter().map(|a| (*a).to_owned()).collect(),
            ..RegistrySettings::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // v1 localPresets.test.ts:9-24.
    #[test]
    fn oh_my_pi_preset_decodes_as_local_settings() {
        let preset = LocalPreset::find("omp").expect("Missing Oh My Pi preset");
        let value = serde_json::to_value(preset.settings()).unwrap();
        let settings = RegistrySettings::decode(&value).unwrap();
        assert_eq!(settings.source, Source::Local);
        assert_eq!(settings.command_path, "omp");
        assert_eq!(
            settings.command_args,
            ["acp", "--approval-mode", "always-ask"]
        );
        assert!(settings.enabled);
    }

    #[test]
    fn minimax_preset_is_recognized_and_others_are_absent() {
        assert!(
            LocalPreset::find("minimax-code")
                .unwrap()
                .settings()
                .is_minimax_code()
        );
        assert!(LocalPreset::find("other").is_none());
        for preset in ACP_LOCAL_PRESETS {
            assert_eq!(
                super::super::local_preset(preset.id).unwrap().args,
                preset.args
            );
        }
    }
}
