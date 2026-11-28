//! Package specs, managers and npm manifests for registry `npx` / `uvx` installs, from v1
//! `registryPackageSpec.ts` (all 22 lines), `registryPackageCommand.ts:4-12` and
//! `AcpRegistrySupport.ts:163-167,899-915` at 916b5ccc1b2. Command candidates stay in
//! [super::package_command_candidates].

use regex::Regex;
use serde::Deserialize;
use std::collections::BTreeMap;

use super::contracts::AcpRegistryDistribution;

/// v1 `registryPackageSpec.ts:1-4`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactPackageSpec {
    pub name: String,
    pub version: String,
}

/// JavaScript `slice` with a `lastIndexOf` result that may be -1.
fn split_at_js(spec: &str, separator: Option<usize>, length: usize) -> ExactPackageSpec {
    let (name, version) = match separator {
        Some(at) => (&spec[..at], &spec[at + length..]),
        // `slice(0, -1)` and `slice(0)`.
        None => (
            spec.char_indices().last().map_or("", |(i, _)| &spec[..i]),
            spec,
        ),
    };
    let version = match version.as_bytes().first() {
        Some(b'v' | b'V') => &version[1..],
        _ => version,
    };
    ExactPackageSpec {
        name: name.to_owned(),
        version: version.to_owned(),
    }
}

/// v1 `registryPackageSpec.ts:6-12`: `name@version`, `v` prefix dropped.
pub fn parse_npx_package_spec(spec: &str) -> ExactPackageSpec {
    split_at_js(spec, spec.rfind('@'), 1)
}

/// v1 `registryPackageSpec.ts:14-22`: `name==version` or `name@version`.
pub fn parse_uvx_package_spec(spec: &str) -> ExactPackageSpec {
    match spec.rfind("==") {
        Some(at) => split_at_js(spec, Some(at), 2),
        None => split_at_js(spec, spec.rfind('@'), 1),
    }
}

/// v1 `registryPackageCommand.ts:10-12`.
pub fn package_manager_for(distribution: AcpRegistryDistribution) -> Option<&'static str> {
    match distribution {
        AcpRegistryDistribution::Npx => Some("npm"),
        AcpRegistryDistribution::Uvx => Some("uv"),
        AcpRegistryDistribution::Binary => None,
    }
}

/// v1 `registryPackageCommand.ts:4-8` `PackageCommandName`.
pub fn is_package_command_name(name: &str) -> bool {
    name.encode_utf16().count() <= 128
        && Regex::new(r"(?i)^[a-z0-9][a-z0-9._-]*$")
            .expect("static regex")
            .is_match(name)
}

/// v1 `AcpRegistrySupport.ts:163-167` `NpmPackageManifest`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct NpmPackageManifest {
    pub name: String,
    pub version: String,
    pub bin: NpmBin,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(untagged)]
pub enum NpmBin {
    Single(String),
    Named(BTreeMap<String, String>),
}

/// Decode a `package.json` as v1 does, including the bounded `bin` entries.
pub fn decode_npm_manifest(text: &str) -> Option<NpmPackageManifest> {
    let manifest: NpmPackageManifest = serde_json::from_str(text).ok()?;
    let bounded = |s: &str| s.encode_utf16().count() <= 1_024;
    let valid = match &manifest.bin {
        NpmBin::Single(path) => bounded(path),
        NpmBin::Named(entries) => entries
            .iter()
            .all(|(name, path)| is_package_command_name(name) && bounded(path)),
    };
    valid.then_some(manifest)
}

/// v1 `AcpRegistrySupport.ts:899-915`: the command a global npm install links for this agent.
pub fn npm_command_name(
    agent_id: &str,
    package_name: &str,
    manifest: &NpmPackageManifest,
) -> Option<String> {
    let base = package_name.rsplit('/').next().unwrap_or(package_name);
    let entries = match &manifest.bin {
        NpmBin::Single(_) => return Some(base.to_owned()),
        // BTreeMap iterates in v1's `compareText` order for these ASCII names.
        NpmBin::Named(entries) => entries,
    };
    if entries.len() == 1 {
        return entries.keys().next().cloned();
    }
    if entries.contains_key(base) {
        return Some(base.to_owned());
    }
    if entries.contains_key(agent_id) {
        return Some(agent_id.to_owned());
    }
    let mut targets = entries.values();
    let first = targets.next()?;
    targets
        .all(|t| t == first)
        .then(|| entries.keys().next().cloned())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs_split_at_the_last_separator() {
        assert_eq!(
            parse_npx_package_spec("@scope/agent@v1.2.3"),
            ExactPackageSpec {
                name: "@scope/agent".into(),
                version: "1.2.3".into()
            }
        );
        assert_eq!(
            parse_uvx_package_spec("fast-agent-acp==0.10.1").name,
            "fast-agent-acp"
        );
        assert_eq!(
            parse_uvx_package_spec("fast-agent-acp==0.10.1").version,
            "0.10.1"
        );
        assert_eq!(parse_uvx_package_spec("tool@V2.0.0").version, "2.0.0");
        assert_eq!(parse_npx_package_spec("noversion").name, "noversio");
    }

    #[test]
    fn manifest_command_selection_follows_v1_order() {
        let m = |bin: &str| {
            decode_npm_manifest(&format!(
                r#"{{"name":"@x/pkg","version":"1.0.0","bin":{bin}}}"#
            ))
            .unwrap()
        };
        assert_eq!(
            npm_command_name("a", "@x/pkg", &m(r#""cli.js""#)).as_deref(),
            Some("pkg")
        );
        assert_eq!(
            npm_command_name("a", "@x/pkg", &m(r#"{"only":"a.js"}"#)).as_deref(),
            Some("only")
        );
        assert_eq!(
            npm_command_name("a", "@x/pkg", &m(r#"{"z":"a.js","pkg":"b.js"}"#)).as_deref(),
            Some("pkg")
        );
        assert_eq!(
            npm_command_name("a", "@x/pkg", &m(r#"{"z":"a.js","a":"b.js"}"#)).as_deref(),
            Some("a")
        );
        assert_eq!(
            npm_command_name("q", "@x/pkg", &m(r#"{"z":"a.js","y":"a.js"}"#)).as_deref(),
            Some("y")
        );
        assert_eq!(
            npm_command_name("q", "@x/pkg", &m(r#"{"z":"a.js","y":"b.js"}"#)),
            None
        );
        assert!(decode_npm_manifest(r#"{"name":"x","version":"1","bin":{"../x":"a"}}"#).is_none());
        assert_eq!(package_manager_for(AcpRegistryDistribution::Binary), None);
        assert!(is_package_command_name("Agent.cli"));
        assert!(!is_package_command_name("-agent"));
    }
}
