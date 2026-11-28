//! Providers (Part 2, docs/part2/provider-wire.md, owner-approved P2-M wire): the provider
//! instances the host knows, their probe results, and the `providers` list pushed to subscribers.
//!
//! Only drivers built into this host get entries: a row needs the driver's capabilities and probe,
//! which only its factory can give. Instances are kept in `<dataDir>/provider-instances.json`
//! (v1 settings `providerInstances`); every built-in driver has a default instance named after
//! its kind. Nothing is published until every enabled instance has been probed once, so a
//! subscriber never sees placeholder rows. A sign-in link an engine asked the person to open
//! (`EngineEvent::AuthRequired`, memory only) shows as `probe.auth.action` on its instance.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use goat2_contracts::{
    AcpRegistryUrlAuthAction, ProviderInstanceId, ProviderProbeResult, ProviderSetup,
    ServerProviderAuth, ServerProviderAuthStatus, ServerProviderEntry, ServerProviderState,
};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use crate::core::Host;
use crate::engine::{EngineError, EngineFactory};

/// The latest list, `None` until every enabled instance was probed once.
pub type ProviderList = Option<Vec<ServerProviderEntry>>;

const FILE: &str = "provider-instances.json";
/// Upper bound on one driver's probe; a slower probe is reported as timed out.
const PROBE_DEADLINE: Duration = Duration::from_secs(30);

/// v1 settings `providerInstances` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInstance {
    pub instance_id: String,
    pub driver: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub acp_agent_id: Option<String>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// Why a provider command was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProviderRefusal {
    NotFound(String),
    DriverUnavailable(String),
    Invalid(String),
    Internal(String),
}

struct State {
    instances: Vec<ProviderInstance>,
    probes: HashMap<String, ProviderProbeResult>,
}

pub struct Providers {
    path: PathBuf,
    factories: BTreeMap<String, Arc<dyn EngineFactory>>,
    state: Mutex<State>,
    list: watch::Sender<ProviderList>,
}

impl Providers {
    /// `factories`: driver kind (v1 `ProviderDriverKind` slug) -> its factory.
    pub fn open(data_dir: &Path, factories: BTreeMap<String, Arc<dyn EngineFactory>>) -> Self {
        let path = data_dir.join(FILE);
        let mut instances: Vec<ProviderInstance> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|err| {
                // Kept aside, not overwritten: the person can still recover it.
                let aside = path.with_extension("json.unreadable");
                tracing::error!(%err, aside = %aside.display(), "provider instances unreadable; using defaults");
                let _ = std::fs::rename(&path, &aside);
                Vec::new()
            }),
            Err(_) => Vec::new(),
        };
        for driver in factories.keys() {
            if !instances.iter().any(|i| &i.instance_id == driver) {
                instances.push(ProviderInstance {
                    instance_id: driver.clone(),
                    driver: driver.clone(),
                    acp_agent_id: None,
                    enabled: true,
                    display_name: None,
                });
            }
        }
        Self {
            path,
            factories,
            state: Mutex::new(State {
                instances,
                probes: HashMap::new(),
            }),
            list: watch::channel(None).0,
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<ProviderList> {
        self.list.subscribe()
    }

    /// The latest published list (`None` before the first probes finished).
    pub fn current(&self) -> ProviderList {
        self.list.borrow().clone()
    }

    /// The driver factory of an instance, for engine starts.
    pub fn factory_for(&self, instance_id: &str) -> Option<Arc<dyn EngineFactory>> {
        let state = self.state.lock().expect("providers");
        let instance = state
            .instances
            .iter()
            .find(|i| i.instance_id == instance_id)?;
        self.factories.get(&instance.driver).cloned()
    }

    /// Probe one instance (or every listed one) again, then publish.
    pub async fn refresh(&self, host: &Host, only: Option<&str>) -> Result<(), ProviderRefusal> {
        let targets: Vec<ProviderInstance> = {
            let state = self.state.lock().expect("providers");
            let listed = state
                .instances
                .iter()
                .filter(|i| self.factories.contains_key(&i.driver));
            match only {
                Some(id) => {
                    let found: Vec<_> = listed.filter(|i| i.instance_id == id).cloned().collect();
                    if found.is_empty() {
                        return Err(ProviderRefusal::NotFound(format!(
                            "No provider instance {id}."
                        )));
                    }
                    found
                }
                None => listed.cloned().collect(),
            }
        };
        let probes = futures_util::future::join_all(targets.iter().map(|i| async move {
            let probe = if i.enabled {
                probe(self.factories[&i.driver].as_ref()).await
            } else {
                status_only(ServerProviderState::Disabled, "Turned off in settings.")
            };
            (i.instance_id.clone(), probe)
        }))
        .await;
        self.state.lock().expect("providers").probes.extend(probes);
        self.publish(host);
        Ok(())
    }

    /// Add or change an instance (v1 settings `providerInstances` upsert), save, publish.
    pub fn set_instance(&self, host: &Host, next: ProviderInstance) -> Result<(), ProviderRefusal> {
        let id = next.instance_id.trim();
        if id.is_empty() || id != next.instance_id {
            return Err(ProviderRefusal::Invalid(
                "instanceId must be a non-empty name without surrounding spaces".into(),
            ));
        }
        if !self.factories.contains_key(&next.driver) {
            return Err(ProviderRefusal::DriverUnavailable(format!(
                "This GOAT 2 build has no {} driver yet.",
                next.driver
            )));
        }
        let saved = {
            let mut state = self.state.lock().expect("providers");
            match state
                .instances
                .iter_mut()
                .find(|i| i.instance_id == next.instance_id)
            {
                Some(existing) => *existing = next.clone(),
                None => state.instances.push(next.clone()),
            }
            if !next.enabled {
                state.probes.insert(
                    next.instance_id.clone(),
                    status_only(ServerProviderState::Disabled, "Turned off in settings."),
                );
            } else if state
                .probes
                .get(&next.instance_id)
                .is_some_and(|p| p.status == ServerProviderState::Disabled)
            {
                // Turned back on: probed again below before it is listed as ready.
                state.probes.remove(&next.instance_id);
            }
            save(&self.path, &state.instances)
        };
        saved
            .map_err(|e| ProviderRefusal::Internal(format!("provider instances not saved: {e}")))?;
        self.publish(host);
        Ok(())
    }

    /// Rebuild the list and push it when it changed. Waits for the first probe of every
    /// enabled instance.
    pub fn publish(&self, host: &Host) {
        let Some(entries) = self.entries(host) else {
            return;
        };
        self.list.send_if_modified(|current| {
            if current.as_ref() == Some(&entries) {
                false
            } else {
                *current = Some(entries);
                true
            }
        });
    }

    fn entries(&self, host: &Host) -> Option<Vec<ServerProviderEntry>> {
        let links = host.signin_links();
        let state = self.state.lock().expect("providers");
        let mut out = Vec::new();
        for instance in &state.instances {
            let Some(factory) = self.factories.get(&instance.driver) else {
                continue; // A driver this build does not have: kept in the file, not listed.
            };
            let mut probe = state.probes.get(&instance.instance_id)?.clone();
            if probe.auth.action.is_none()
                && let Some(link) = links.iter().rev().find(|l| {
                    host.store().card(&l.thread_id).is_some_and(|c| {
                        c.engine.provider_instance_id.as_str() == instance.instance_id
                    })
                })
            {
                probe.auth.action = Some(AcpRegistryUrlAuthAction {
                    elicitation_id: link.request_id.to_string(),
                    url: link.url.clone(),
                    message: link.message.clone(),
                    created_at: None,
                    expires_at: None,
                });
            }
            out.push(ServerProviderEntry {
                instance_id: ProviderInstanceId::new(instance.instance_id.clone()),
                driver: instance.driver.clone(),
                display_name: instance.display_name.clone(),
                enabled: instance.enabled,
                acp_agent_id: instance.acp_agent_id.clone(),
                // Install and sign-in from GOAT 2 are not in this host build yet.
                setup: Some(ProviderSetup {
                    can_authenticate: false,
                    can_install: false,
                    documentation_url: None,
                }),
                capabilities: factory.capabilities(),
                probe,
                auth_flow: None,
                install: None,
            });
        }
        Some(out)
    }
}

async fn probe(factory: &dyn EngineFactory) -> ProviderProbeResult {
    match tokio::time::timeout(PROBE_DEADLINE, factory.probe()).await {
        Ok(Ok(probe)) => probe,
        Ok(Err(EngineError::Unsupported(_))) => status_only(
            ServerProviderState::Warning,
            "This driver cannot report its status yet.",
        ),
        Ok(Err(err)) => status_only(ServerProviderState::Error, &err.to_string()),
        Err(_) => status_only(ServerProviderState::Error, "The status check timed out."),
    }
}

/// A row with only a state and a reason: nothing about install, sign-in or models is known.
fn status_only(status: ServerProviderState, message: &str) -> ProviderProbeResult {
    ProviderProbeResult {
        installed: false,
        version: None,
        installed_version: None,
        cli: None,
        binary_path: None,
        status,
        auth: unknown_auth(),
        models: Vec::new(),
        checked_at: crate::util::now_rfc3339(),
        message: Some(message.to_owned()),
    }
}

fn unknown_auth() -> ServerProviderAuth {
    serde_json::from_value(serde_json::json!({ "status": ServerProviderAuthStatus::Unknown }))
        .expect("an auth with only a status decodes")
}

fn save(path: &Path, instances: &[ProviderInstance]) -> std::io::Result<()> {
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(instances).map_err(std::io::Error::other)?;
    std::fs::write(&tmp, body)?;
    std::fs::rename(tmp, path)
}
