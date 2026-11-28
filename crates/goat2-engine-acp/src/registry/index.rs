//! Registry index decoding and search, from v1 `AcpRegistrySupport.ts:90-160,182-189,594-625`
//! and `registrySearch.ts:3-25` at 916b5ccc1b2.
#[path = "cache.rs"]
pub mod cache;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub const REGISTRY_URL: &str =
    "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";
/// v1 `client.ts:6-10`.
pub const DRIVER_KIND: &str = "acpRegistry";
pub const CLIENT_LABEL: &str = "ACP Registry";
pub const HAS_DEFAULT_INSTANCE: bool = false;
pub const MAX_AGENTS: usize = 512;
pub const MAX_REGISTRY_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Index {
    pub version: String,
    pub agents: Vec<Agent>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Agent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub authors: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub license: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub website: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repository: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub distribution: Distributions,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Distributions {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub binary: Option<BTreeMap<String, BinaryTarget>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub npx: Option<Package>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub uvx: Option<Package>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Package {
    pub package: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BinaryTarget {
    pub archive: String,
    pub cmd: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub args: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env: Option<BTreeMap<String, String>>,
}
fn chars(s: &str) -> usize {
    s.encode_utf16().count()
}
fn re(pattern: &str, value: &str) -> bool {
    Regex::new(pattern).expect("static regex").is_match(value)
}
fn version(s: &str) -> bool {
    chars(s) <= 128 && re(r"^[A-Za-z0-9][A-Za-z0-9._+\-]*$", s)
}
pub fn valid_https_url(s: &str) -> bool {
    chars(s) <= 2048
        && reqwest::Url::parse(s).is_ok_and(|u| {
            u.scheme() == "https" && u.username().is_empty() && u.password().is_none()
        })
}
pub fn official_icon_url(id: &str) -> Option<String> {
    re(r"^[a-z0-9][a-z0-9._-]*$", id)
        .then(|| format!("https://cdn.agentclientprotocol.com/registry/v1/latest/{id}.svg"))
}
pub fn resolve_official_icon_url(s: &str) -> Option<String> {
    let u = reqwest::Url::parse(s).ok()?;
    (u.scheme() == "https"
        && u.host_str() == Some("cdn.agentclientprotocol.com")
        && u.port().is_none()
        && u.username().is_empty()
        && u.password().is_none())
    .then(|| u.to_string())
}
fn args_env(args: &Option<Vec<String>>, env: &Option<BTreeMap<String, String>>) -> bool {
    args.as_ref()
        .is_none_or(|a| a.len() <= 64 && a.iter().all(|s| chars(s) <= 1024))
        && env
            .as_ref()
            .is_none_or(|e| e.iter().all(|(k, v)| chars(k) <= 256 && chars(v) <= 1024))
}
fn package(p: &Package, npx: bool) -> bool {
    let pat = if npx {
        r"(?i)^(?:@[^/@\s]+/[^@\s]+|[a-z0-9][a-z0-9._-]*)@v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$"
    } else {
        r"(?i)^[a-z0-9][a-z0-9._-]*(?:@|==)v?[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9a-z.-]+)?(?:\+[0-9a-z.-]+)?$"
    };
    chars(&p.package) <= 256 && re(pat, &p.package) && args_env(&p.args, &p.env)
}
fn valid_agent(a: &Agent) -> bool {
    chars(&a.id) <= 128
        && re(r"^[a-z0-9][a-z0-9._-]*$", &a.id)
        && !a.name.trim().is_empty()
        && chars(a.name.trim()) <= 160
        && version(a.version.trim())
        && chars(&a.description) <= 1024
        && a.authors
            .as_ref()
            .is_none_or(|x| x.len() <= 16 && x.iter().all(|s| chars(s) <= 256))
        && a.license.as_ref().is_none_or(|s| chars(s) <= 128)
        && [&a.website, &a.repository, &a.icon]
            .into_iter()
            .all(|x| x.as_ref().is_none_or(|s| valid_https_url(s)))
        && a.distribution.npx.as_ref().is_none_or(|p| package(p, true))
        && a.distribution
            .uvx
            .as_ref()
            .is_none_or(|p| package(p, false))
        && a.distribution.binary.as_ref().is_none_or(|b| {
            b.values().all(|t| {
                valid_https_url(&t.archive)
                    && chars(&t.cmd) <= 1024
                    && t.sha256
                        .as_ref()
                        .is_none_or(|s| re(r"(?i)^[a-f0-9]{64}$", s))
                    && args_env(&t.args, &t.env)
            })
        })
}
/// v1 `AcpRegistrySupport.ts:693-698` size error.
pub fn index_too_large() -> String {
    format!("ACP Registry index exceeds {MAX_REGISTRY_BYTES} bytes.")
}
/// Decode the envelope strictly, discarding malformed individual agents
/// (v1 `AcpRegistrySupport.ts:594-626,693-705`), with v1's messages.
pub fn decode(bytes: &[u8]) -> Result<Index, String> {
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err(index_too_large());
    }
    let text = std::str::from_utf8(bytes)
        .map_err(|_| "ACP Registry index is not valid UTF-8.".to_owned())?;
    let value: Value =
        serde_json::from_str(text).map_err(|_| "ACP Registry returned invalid JSON.".to_owned())?;
    let invalid = || "ACP Registry returned an invalid index.".to_owned();
    let ver = value
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?
        .trim();
    let agents = value
        .get("agents")
        .and_then(Value::as_array)
        .ok_or_else(invalid)?;
    if !version(ver) || agents.len() > MAX_AGENTS {
        return Err(invalid());
    }
    let agents = agents
        .iter()
        .filter_map(|v| serde_json::from_value::<Agent>(v.clone()).ok())
        .filter(valid_agent)
        .map(|mut a| {
            a.name = a.name.trim().to_owned();
            a.version = a.version.trim().to_owned();
            a
        })
        .collect();
    Ok(Index {
        version: ver.into(),
        agents,
    })
}
/// v1 `registrySearch.ts:7-24`.
pub fn search_rank(a: &Agent, query: &str) -> Option<u8> {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Some(100);
    }
    let id = a.id.to_lowercase();
    let name = a.name.to_lowercase();
    let authors = a
        .authors
        .as_deref()
        .unwrap_or_default()
        .join(" ")
        .to_lowercase();
    let desc = a.description.to_lowercase();
    let terms: Vec<_> = q.split_whitespace().collect();
    if id == q || name == q {
        return Some(0);
    }
    if id.starts_with(&q) || name.starts_with(&q) {
        return Some(10);
    }
    let identity = format!("{id} {name}");
    let tokens: Vec<_> = identity
        .split(|c: char| !c.is_ascii_lowercase() && !c.is_ascii_digit())
        .filter(|s| !s.is_empty())
        .collect();
    if terms
        .iter()
        .all(|t| tokens.iter().any(|s| s.starts_with(t)))
    {
        return Some(20);
    }
    if terms.iter().all(|t| id.contains(t) || name.contains(t)) {
        return Some(30);
    }
    if terms.iter().all(|t| authors.contains(t)) {
        return Some(40);
    }
    let all = format!("{id} {name} {authors} {desc}");
    terms.iter().all(|t| all.contains(t)).then_some(50)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn decode_discards_bad_agents_and_ranks() {
        let x=decode(br#"{"version":"1.0","agents":[{"id":"agent-one","name":"Agent One","version":"1.0","description":"Helpful bot","authors":["Acme"],"distribution":{"npx":{"package":"agent@1.2.3"}}},{"id":"../bad","name":"Bad","version":"1","description":"","distribution":{}}]}"#).unwrap();
        assert_eq!(x.agents.len(), 1);
        let a = &x.agents[0];
        assert_eq!(search_rank(a, "agent-one"), Some(0));
        assert_eq!(search_rank(a, "one agent"), Some(20));
        assert_eq!(search_rank(a, "acme"), Some(40));
        assert_eq!(search_rank(a, "helpful"), Some(50));
        assert_eq!(search_rank(a, "missing"), None);
        assert!(!valid_https_url("https://u:p@example.com"));
        assert!(official_icon_url("../bad").is_none());
    }
}

use super::contracts::{AcpRegistryDistribution, AcpRegistryIntegrity, AcpRegistrySearchAgent};
pub use super::settings::{DistributionPreference, RegistrySettings, Source};

/// v1 `AcpRegistrySupport.ts:320-326`.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedDistribution {
    pub kind: AcpRegistryDistribution,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub binary_target: Option<BinaryTarget>,
    pub package_name: Option<String>,
}
/// v1 `AcpRegistrySupport.ts:328-367`: `auto` tries binary, npx, uvx; a binary uses the first
/// platform candidate the agent ships.
pub fn resolve_distribution(
    agent: &Agent,
    preference: &DistributionPreference,
    target: Option<&str>,
) -> Option<ResolvedDistribution> {
    let binary = super::platform_candidates(target)
        .into_iter()
        .find_map(|k| agent.distribution.binary.as_ref()?.get(k));
    let kinds: &[AcpRegistryDistribution] = match preference {
        DistributionPreference::Auto => &[
            AcpRegistryDistribution::Binary,
            AcpRegistryDistribution::Npx,
            AcpRegistryDistribution::Uvx,
        ],
        DistributionPreference::Binary => &[AcpRegistryDistribution::Binary],
        DistributionPreference::Npx => &[AcpRegistryDistribution::Npx],
        DistributionPreference::Uvx => &[AcpRegistryDistribution::Uvx],
    };
    for kind in kinds {
        match kind {
            AcpRegistryDistribution::Binary => {
                if let Some(t) = binary {
                    return Some(ResolvedDistribution {
                        kind: *kind,
                        args: t.args.clone().unwrap_or_default(),
                        env: t.env.clone().unwrap_or_default(),
                        binary_target: Some(t.clone()),
                        package_name: None,
                    });
                }
            }
            AcpRegistryDistribution::Npx | AcpRegistryDistribution::Uvx => {
                let package = if *kind == AcpRegistryDistribution::Npx {
                    agent.distribution.npx.as_ref()
                } else {
                    agent.distribution.uvx.as_ref()
                };
                if let Some(p) = package {
                    return Some(ResolvedDistribution {
                        kind: *kind,
                        args: p.args.clone().unwrap_or_default(),
                        env: p.env.clone().unwrap_or_default(),
                        binary_target: None,
                        package_name: Some(p.package.clone()),
                    });
                }
            }
        }
    }
    None
}

/// v1 `registryIndexCache.ts:17-40`: the launch identity, byte for byte as v1's `JSON.stringify`
/// (key order kept; env entries sorted by `compareText`).
pub fn launch_identity(
    version: Option<&str>,
    distribution: &ResolvedDistribution,
    command_override: Option<&str>,
) -> String {
    fn json<T: Serialize + ?Sized>(value: &T) -> String {
        serde_json::to_string(value).unwrap_or_default()
    }
    let mut s = format!(
        "{{\"version\":{},\"kind\":{}",
        json(&version),
        json(distribution.kind.as_str())
    );
    if let Some(c) = command_override.filter(|s| !s.is_empty()) {
        s.push_str(&format!(",\"commandOverride\":{}", json(c)));
    }
    if let Some(p) = distribution
        .package_name
        .as_deref()
        .filter(|s| !s.is_empty())
    {
        s.push_str(&format!(",\"packageName\":{}", json(p)));
    }
    if let Some(b) = &distribution.binary_target {
        s.push_str(&format!(
            ",\"archive\":{},\"cmd\":{},\"sha256\":{}",
            json(&b.archive),
            json(&b.cmd),
            json(&b.sha256)
        ));
    }
    s.push_str(&format!(
        ",\"args\":{},\"env\":{}}}",
        json(&distribution.args),
        json(&distribution.env.iter().collect::<Vec<_>>())
    ));
    s
}

/// v1 `AcpRegistrySupport.ts:82`.
pub const DEFAULT_SEARCH_LIMIT: usize = 20;

/// v1 `AcpRegistrySupport.ts:1478-1528`: compatible agents whose package manager is available,
/// by rank, then lowercase name, then id.
pub fn search(
    index: &Index,
    query: &str,
    limit: Option<usize>,
    target: Option<&str>,
    mut manager_available: impl FnMut(&str) -> bool,
) -> Result<Vec<AcpRegistrySearchAgent>, String> {
    let q = query.trim();
    if chars(q) > 120 || limit.is_some_and(|n| n == 0 || n > MAX_AGENTS) {
        return Err("invalid search input".into());
    }
    let mut availability: BTreeMap<&str, bool> = BTreeMap::new();
    let mut ranked = Vec::new();
    for a in &index.agents {
        let Some(d) = resolve_distribution(a, &DistributionPreference::Auto, target) else {
            continue;
        };
        let Some(rank) = search_rank(a, q) else {
            continue;
        };
        if let Some(manager) = super::package::package_manager_for(d.kind) {
            let available = *availability
                .entry(manager)
                .or_insert_with(|| manager_available(manager));
            if !available {
                continue;
            }
        }
        ranked.push((rank, a, d));
    }
    ranked.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase()))
            .then_with(|| a.1.id.cmp(&b.1.id))
    });
    Ok(ranked
        .into_iter()
        .take(limit.unwrap_or(DEFAULT_SEARCH_LIMIT))
        .map(|(_, a, d)| AcpRegistrySearchAgent {
            id: a.id.clone(),
            name: a.name.clone(),
            version: a.version.clone(),
            description: a.description.clone(),
            authors: a.authors.clone().unwrap_or_default(),
            license: a.license.clone(),
            website: a.website.clone(),
            repository: a.repository.clone(),
            icon: a.icon.clone(),
            distribution: d.kind,
            integrity: if d.kind == AcpRegistryDistribution::Binary
                && d.binary_target.as_ref().is_some_and(|t| t.sha256.is_some())
            {
                AcpRegistryIntegrity::Sha256
            } else {
                AcpRegistryIntegrity::Registry
            },
        })
        .collect())
}

#[cfg(test)]
mod index_tests {
    use super::*;
    #[test]
    fn distribution_and_search_follow_v1_order() {
        let index=decode(br#"{"version":"1","agents":[{"id":"hello","name":"Hello","version":"1","description":"a","distribution":{"npx":{"package":"hello@1.0.0"},"uvx":{"package":"hello==1.0.0"},"binary":{"windows-x86_64":{"archive":"https://example.com/a","cmd":"bin/app","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}]}"#).unwrap();
        let a = &index.agents[0];
        let d = resolve_distribution(a, &DistributionPreference::Auto, Some("windows-aarch64"))
            .unwrap();
        assert_eq!(d.kind, AcpRegistryDistribution::Binary);
        assert_eq!(
            resolve_distribution(a, &DistributionPreference::Auto, Some("linux-x86_64"))
                .unwrap()
                .kind,
            AcpRegistryDistribution::Npx
        );
        assert_eq!(
            resolve_distribution(a, &DistributionPreference::Uvx, None)
                .unwrap()
                .kind,
            AcpRegistryDistribution::Uvx
        );
        assert!(resolve_distribution(a, &DistributionPreference::Binary, None).is_none());
        assert_eq!(
            search(&index, "hello", None, Some("windows-aarch64"), |_| false).unwrap()[0].integrity,
            AcpRegistryIntegrity::Sha256
        );
        assert!(
            search(&index, "hello", None, None, |_| false)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            search(&index, "hello", None, None, |m| m == "npm").unwrap()[0].distribution,
            AcpRegistryDistribution::Npx
        );
    }
    #[test]
    fn malformed_distributions_are_discarded() {
        let doc=br#"{"version":"1","agents":[{"id":"bad","name":"Bad","version":"1","description":"","distribution":{"npx":{"package":"bad@latest"}}},{"id":"bad2","name":"Bad","version":"1","description":"","distribution":{"binary":{"linux-x86_64":{"archive":"https://u:p@example.com/file","cmd":"bin"}}}}]}"#;
        assert!(decode(doc).unwrap().agents.is_empty());
        assert_eq!(
            decode(br#"{"version":"..","agents":[]}"#).unwrap_err(),
            "ACP Registry returned an invalid index."
        );
        assert_eq!(
            decode(b"{").unwrap_err(),
            "ACP Registry returned invalid JSON."
        );
        assert_eq!(
            decode(b"\xff").unwrap_err(),
            "ACP Registry index is not valid UTF-8."
        );
        assert_eq!(
            decode(&vec![b' '; MAX_REGISTRY_BYTES + 1]).unwrap_err(),
            "ACP Registry index exceeds 1048576 bytes."
        );
    }
    #[test]
    fn launch_identity_matches_v1_json() {
        let d = ResolvedDistribution {
            kind: AcpRegistryDistribution::Binary,
            args: vec!["acp".into()],
            env: [("B".into(), "2".into()), ("A".into(), "1".into())].into(),
            binary_target: Some(BinaryTarget {
                archive: "https://x.test/a.zip".into(),
                cmd: "./a".into(),
                sha256: None,
                args: None,
                env: None,
            }),
            package_name: None,
        };
        assert_eq!(
            launch_identity(Some("1.0"), &d, Some("/bin/a")),
            r#"{"version":"1.0","kind":"binary","commandOverride":"/bin/a","archive":"https://x.test/a.zip","cmd":"./a","sha256":null,"args":["acp"],"env":[["A","1"],["B","2"]]}"#
        );
        let npx = ResolvedDistribution {
            kind: AcpRegistryDistribution::Npx,
            args: vec![],
            env: BTreeMap::new(),
            binary_target: None,
            package_name: Some("a@1.0.0".into()),
        };
        assert_eq!(
            launch_identity(None, &npx, Some("")),
            r#"{"version":null,"kind":"npx","packageName":"a@1.0.0","args":[],"env":[]}"#
        );
    }
}
