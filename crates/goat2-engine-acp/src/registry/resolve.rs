//! Registry distribution selection, from v1 `AcpRegistrySupport.ts:124-159,328-367`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use super::platform_candidates;

/// The distribution fields in the v1 registry index.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
pub struct Distribution {
    #[serde(default)]
    pub binary: BTreeMap<String, BinaryTarget>,
    pub npx: Option<Package>,
    pub uvx: Option<Package>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct Package {
    pub package: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    pub sha256: Option<String>,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Preference {
    Auto,
    Binary,
    Npx,
    Uvx,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Selected<'a> {
    Binary {
        platform: &'a str,
        target: &'a BinaryTarget,
    },
    Npx(&'a Package),
    Uvx(&'a Package),
}

/// v1 `AcpRegistrySupport.ts:328-367`: auto prefers binary, then npx, then uvx.
pub fn select<'a>(
    distribution: &'a Distribution,
    preference: Preference,
    platform: Option<&'a str>,
) -> Option<Selected<'a>> {
    if matches!(preference, Preference::Auto | Preference::Binary) {
        for candidate in platform_candidates(platform) {
            if let Some(target) = distribution.binary.get(candidate) {
                return Some(Selected::Binary {
                    platform: candidate,
                    target,
                });
            }
        }
    }
    if matches!(preference, Preference::Auto | Preference::Npx)
        && let Some(package) = &distribution.npx
    {
        return Some(Selected::Npx(package));
    }
    if matches!(preference, Preference::Auto | Preference::Uvx)
        && let Some(package) = &distribution.uvx
    {
        return Some(Selected::Uvx(package));
    }
    None
}

/// v1 `registryArchive.ts:1-12`: normalize a relative executable path.
pub fn normalize_registry_command_path(command: &str) -> Option<Vec<String>> {
    let normalized = command.trim().replace('\\', "/");
    let normalized = normalized.strip_prefix("./").unwrap_or(&normalized);
    if normalized.starts_with('/')
        || normalized.as_bytes().get(1) == Some(&b':')
            && normalized.as_bytes()[0].is_ascii_alphabetic()
    {
        return None;
    }
    let segments: Vec<_> = normalized
        .split('/')
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect();
    if segments.is_empty() || segments.iter().any(|s| s == "." || s == "..") {
        None
    } else {
        Some(segments)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selection_and_windows_fallback() {
        let d: Distribution = serde_json::from_str(r#"{"binary":{"windows-x86_64":{"archive":"https://example.test/a.zip","cmd":"bin/a.exe"}},"npx":{"package":"a@1.0.0"},"uvx":{"package":"a==1.0.0"}}"#).unwrap();
        assert!(matches!(
            select(&d, Preference::Auto, Some("windows-aarch64")),
            Some(Selected::Binary {
                platform: "windows-x86_64",
                ..
            })
        ));
        assert!(matches!(
            select(&d, Preference::Auto, Some("linux-x86_64")),
            Some(Selected::Npx(_))
        ));
        assert!(matches!(
            select(&d, Preference::Uvx, None),
            Some(Selected::Uvx(_))
        ));
        assert!(select(&d, Preference::Binary, None).is_none());
    }
    #[test]
    fn rejects_escaping_paths() {
        assert_eq!(
            normalize_registry_command_path(" ./bin\\agent "),
            Some(vec!["bin".into(), "agent".into()])
        );
        for p in ["", "../x", "/x", "C:\\x", "a/./b", "a/../b"] {
            assert!(normalize_registry_command_path(p).is_none(), "{p}");
        }
    }
}
