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
/// Decode the envelope strictly, discarding malformed individual agents (v1 `AcpRegistrySupport.ts:594-625`).
pub fn decode(bytes: &[u8]) -> Result<Index, String> {
    if bytes.len() > MAX_REGISTRY_BYTES {
        return Err("index too large".into());
    }
    let value: Value = serde_json::from_slice(bytes).map_err(|e| e.to_string())?;
    let ver = value
        .get("version")
        .and_then(Value::as_str)
        .ok_or("missing version")?
        .trim();
    let agents = value
        .get("agents")
        .and_then(Value::as_array)
        .ok_or("missing agents")?;
    if !version(ver) || agents.len() > MAX_AGENTS {
        return Err("invalid index envelope".into());
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

/// v1 `settings.ts:10-11,27-112`, registry instance settings.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct RegistrySettings {
    pub source: Source,
    pub enabled: bool,
    pub agent_id: String,
    pub command_path: String,
    pub command_args: Vec<String>,
    pub read_mini_max_code_quota: bool,
    pub auth_method_id: String,
    pub distribution: DistributionPreference,
    pub custom_models: Vec<CustomModel>,
    pub custom_model_details: Option<Vec<CustomModelEntry>>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Source {
    Registry,
    Local,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DistributionPreference {
    Auto,
    Binary,
    Npx,
    Uvx,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum CustomModel {
    Slug(String),
    Entry(CustomModelEntry),
}
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomModelEntry {
    pub slug: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<Value>,
}
impl Default for RegistrySettings {
    fn default() -> Self {
        Self {
            source: Source::Registry,
            enabled: true,
            agent_id: String::new(),
            command_path: String::new(),
            command_args: vec![],
            read_mini_max_code_quota: false,
            auth_method_id: String::new(),
            distribution: DistributionPreference::Auto,
            custom_models: vec![],
            custom_model_details: None,
        }
    }
}
impl RegistrySettings {
    /// v1 `settings.ts:13-25`.
    pub fn is_minimax_code(&self) -> bool {
        matches!(self.source, Source::Local)
            && self.command_path.trim().rsplit('/').next() == Some("mcode")
            && self.command_args == ["acp"]
    }
    /// v1 `settings.ts:100-110`.
    pub fn validate_model_details(&self) -> bool {
        let ids: std::collections::HashSet<&str> = self
            .custom_models
            .iter()
            .map(|m| match m {
                CustomModel::Slug(s) => s.as_str(),
                CustomModel::Entry(e) => e.slug.as_str(),
            })
            .collect();
        let mut seen = std::collections::HashSet::new();
        self.custom_model_details
            .as_deref()
            .unwrap_or_default()
            .iter()
            .all(|e| ids.contains(e.slug.as_str()) && seen.insert(e.slug.as_str()))
    }
    /// v1 `customModels.ts:4-10`.
    pub fn resolved_custom_models(&self) -> Vec<CustomModel> {
        self.custom_models
            .iter()
            .map(|m| {
                let id = match m {
                    CustomModel::Slug(s) => s,
                    CustomModel::Entry(e) => &e.slug,
                };
                self.custom_model_details
                    .as_deref()
                    .unwrap_or_default()
                    .iter()
                    .find(|e| &e.slug == id)
                    .cloned()
                    .map(CustomModel::Entry)
                    .unwrap_or_else(|| m.clone())
            })
            .collect()
    }
}

/// v1 `AcpRegistrySupport.ts:320-367`: pick the first compatible distribution.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedDistribution {
    pub kind: &'static str,
    pub args: Vec<String>,
    pub env: BTreeMap<String, String>,
    pub binary_target: Option<BinaryTarget>,
    pub package_name: Option<String>,
}
pub fn resolve_distribution(
    agent: &Agent,
    preference: &DistributionPreference,
    target: Option<&str>,
) -> Option<ResolvedDistribution> {
    let kinds: &[&str] = match preference {
        DistributionPreference::Auto => &["binary", "npx", "uvx"],
        DistributionPreference::Binary => &["binary"],
        DistributionPreference::Npx => &["npx"],
        DistributionPreference::Uvx => &["uvx"],
    };
    for kind in kinds {
        match *kind {
            "binary" => {
                if let Some(b) = &agent.distribution.binary
                    && let Some(t) = super::platform_candidates(target)
                        .into_iter()
                        .find_map(|k| b.get(k))
                {
                    return Some(ResolvedDistribution {
                        kind: "binary",
                        args: t.args.clone().unwrap_or_default(),
                        env: t.env.clone().unwrap_or_default(),
                        binary_target: Some(t.clone()),
                        package_name: None,
                    });
                }
            }
            "npx" | "uvx" => {
                let p = if *kind == "npx" {
                    agent.distribution.npx.as_ref()
                } else {
                    agent.distribution.uvx.as_ref()
                };
                if let Some(p) = p {
                    return Some(ResolvedDistribution {
                        kind: if *kind == "npx" { "npx" } else { "uvx" },
                        args: p.args.clone().unwrap_or_default(),
                        env: p.env.clone().unwrap_or_default(),
                        binary_target: None,
                        package_name: Some(p.package.clone()),
                    });
                }
            }
            _ => {}
        }
    }
    None
}

/// v1 `registryIndexCache.ts:17-40`: stable launch identity, including sorted env entries.
pub fn launch_identity(
    version: Option<&str>,
    distribution: &ResolvedDistribution,
    command_override: Option<&str>,
) -> String {
    let mut o = serde_json::Map::new();
    o.insert("version".into(), serde_json::json!(version));
    o.insert("kind".into(), serde_json::json!(distribution.kind));
    if let Some(c) = command_override.filter(|s| !s.is_empty()) {
        o.insert("commandOverride".into(), serde_json::json!(c));
    }
    if let Some(p) = &distribution.package_name {
        o.insert("packageName".into(), serde_json::json!(p));
    }
    if let Some(b) = &distribution.binary_target {
        o.insert("archive".into(), serde_json::json!(b.archive));
        o.insert("cmd".into(), serde_json::json!(b.cmd));
        o.insert("sha256".into(), serde_json::json!(b.sha256));
    }
    o.insert("args".into(), serde_json::json!(distribution.args));
    o.insert(
        "env".into(),
        serde_json::json!(distribution.env.iter().collect::<Vec<_>>()),
    );
    serde_json::Value::Object(o).to_string()
}

/// v1 `AcpRegistrySupport.ts:1478-1528`: only show compatible agents whose package manager is available.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SearchAgent {
    pub id: String,
    pub name: String,
    pub version: String,
    pub description: String,
    pub authors: Vec<String>,
    pub license: Option<String>,
    pub website: Option<String>,
    pub repository: Option<String>,
    pub icon: Option<String>,
    pub distribution: String,
    pub integrity: String,
}
pub fn search(
    index: &Index,
    query: &str,
    limit: Option<usize>,
    target: Option<&str>,
    manager_available: impl Fn(&str) -> bool,
) -> Result<Vec<SearchAgent>, String> {
    let q = query.trim();
    if chars(q) > 120 || limit.is_some_and(|n| n == 0 || n > 512) {
        return Err("invalid search input".into());
    }
    let mut ranked: Vec<_> = index
        .agents
        .iter()
        .filter_map(|a| {
            let rank = search_rank(a, q)?;
            let d = resolve_distribution(a, &DistributionPreference::Auto, target)?;
            let manager = match d.kind {
                "npx" => Some("npm"),
                "uvx" => Some("uv"),
                _ => None,
            };
            if manager.is_some_and(|m| !manager_available(m)) {
                return None;
            }
            Some((rank, a, d))
        })
        .collect();
    ranked.sort_by(|a, b| {
        a.0.cmp(&b.0)
            .then_with(|| a.1.name.to_lowercase().cmp(&b.1.name.to_lowercase()))
            .then_with(|| a.1.id.cmp(&b.1.id))
    });
    Ok(ranked
        .into_iter()
        .take(limit.unwrap_or(20))
        .map(|(_, a, d)| SearchAgent {
            id: a.id.clone(),
            name: a.name.clone(),
            version: a.version.clone(),
            description: a.description.clone(),
            authors: a.authors.clone().unwrap_or_default(),
            license: a.license.clone(),
            website: a.website.clone(),
            repository: a.repository.clone(),
            icon: a.icon.clone(),
            distribution: d.kind.into(),
            integrity: if d.binary_target.as_ref().is_some_and(|t| t.sha256.is_some()) {
                "sha256"
            } else {
                "registry"
            }
            .into(),
        })
        .collect())
}

#[cfg(test)]
mod index_tests {
    use super::*;
    #[test]
    fn distribution_and_search_follow_v1_order() {
        let index=decode(br#"{"version":"1","agents":[{"id":"hello","name":"Hello","version":"1","description":"a","distribution":{"npx":{"package":"hello@1.0.0"},"uvx":{"package":"hello==1.0.0"},"binary":{"windows-x86_64":{"archive":"https://example.com/a","cmd":"bin/app","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}}]}"#).unwrap();
        let d = resolve_distribution(
            &index.agents[0],
            &DistributionPreference::Auto,
            Some("windows-aarch64"),
        )
        .unwrap();
        assert_eq!(d.kind, "binary");
        assert_eq!(
            search(&index, "hello", None, Some("windows-aarch64"), |_| false).unwrap()[0].integrity,
            "sha256"
        );
        assert!(
            search(&index, "hello", None, None, |_| false)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            search(&index, "hello", None, None, |m| m == "npm").unwrap()[0].distribution,
            "npx"
        );
    }
    #[test]
    fn malformed_distributions_are_discarded() {
        let doc=br#"{"version":"1","agents":[{"id":"bad","name":"Bad","version":"1","description":"","distribution":{"npx":{"package":"bad@latest"}}},{"id":"bad2","name":"Bad","version":"1","description":"","distribution":{"binary":{"linux-x86_64":{"archive":"https://u:p@example.com/file","cmd":"bin"}}}}]}"#;
        assert!(decode(doc).unwrap().agents.is_empty());
        assert!(decode(br#"{"version":"..","agents":[]}"#).is_err());
    }
    #[test]
    fn custom_model_details_must_match_and_are_applied() {
        let mut s = RegistrySettings::default();
        s.custom_models.push(CustomModel::Slug("x".into()));
        s.custom_model_details = Some(vec![CustomModelEntry {
            slug: "x".into(),
            name: Some("Name".into()),
            capabilities: None,
        }]);
        assert!(s.validate_model_details());
        assert!(
            matches!(&s.resolved_custom_models()[0],CustomModel::Entry(e) if e.name.as_deref()==Some("Name"))
        );
        let duplicate = s.custom_model_details.as_ref().unwrap()[0].clone();
        s.custom_model_details.as_mut().unwrap().push(duplicate);
        assert!(!s.validate_model_details());
    }
}
