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
    AcpRegistryUrlAuthAction, ProviderAuthPhase, ProviderAuthState, ProviderInstallPhase,
    ProviderInstallState, ProviderInstanceId, ProviderProbeResult, ServerProviderAuth,
    ServerProviderAuthStatus, ServerProviderEntry, ServerProviderState,
};
use serde::{Deserialize, Serialize};
use tokio::sync::{mpsc, watch};

use crate::core::Host;
use crate::engine::{EngineError, EngineFactory, ProviderTarget};

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
    /// The driver does not offer this (EngineError::Unsupported).
    NotAvailable(String),
    Invalid(String),
    Internal(String),
}

struct State {
    instances: Vec<ProviderInstance>,
    probes: HashMap<String, ProviderProbeResult>,
    /// Latest sign-in state per instance (memory only: a flow does not survive a restart).
    auth: HashMap<String, ProviderAuthState>,
    /// Latest install state per driver kind.
    installs: HashMap<String, ProviderInstallState>,
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
                auth: HashMap::new(),
                installs: HashMap::new(),
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

    /// The factory a thread's engine starts with (the factory registry: provider instance ->
    /// its driver), or why it cannot start (v1 refuses a provider that is off or unknown).
    pub fn factory_for_start(&self, instance_id: &str) -> Result<Arc<dyn EngineFactory>, String> {
        let state = self.state.lock().expect("providers");
        let Some(instance) = state
            .instances
            .iter()
            .find(|i| i.instance_id == instance_id)
        else {
            return Err(format!("provider {instance_id} is not set up in this host"));
        };
        if !instance.enabled {
            return Err(format!("provider {instance_id} is turned off in settings"));
        }
        self.factories
            .get(&instance.driver)
            .cloned()
            .ok_or_else(|| format!("this host has no {} driver", instance.driver))
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
            let factory = self.factories[&i.driver].as_ref();
            let probe = if i.enabled {
                probe(factory).await
            } else {
                status_only(ServerProviderState::Disabled, "Turned off in settings.")
            };
            // Sign-in methods for an instance with no flow yet (v1 lists them idle).
            let methods = if i.enabled && factory.setup().can_authenticate {
                factory.auth_methods(&target_of(i)).await.ok()
            } else {
                None
            };
            (i.instance_id.clone(), probe, methods)
        }))
        .await;
        {
            let mut state = self.state.lock().expect("providers");
            for (id, probe, methods) in probes {
                state.probes.insert(id.clone(), probe);
                if let Some(methods) = methods
                    && state
                        .auth
                        .get(&id)
                        .is_none_or(|a| a.phase == ProviderAuthPhase::Idle)
                {
                    state.auth.insert(id.clone(), idle_auth(&id, methods));
                }
            }
        }
        self.publish(host);
        Ok(())
    }

    /// `provider_auth_start`: a running flow of the instance is returned as is (v1).
    pub async fn auth_start(
        &self,
        host: &Host,
        instance_id: &str,
        method_id: Option<String>,
    ) -> Result<ProviderAuthState, ProviderRefusal> {
        let (instance, factory) = self.lookup(instance_id)?;
        let running = self
            .state
            .lock()
            .expect("providers")
            .auth
            .get(instance_id)
            .filter(|a| auth_running(&a.phase))
            .cloned();
        if let Some(running) = running {
            return Ok(running);
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let state = factory
            .auth_start(&target_of(&instance), method_id, tx)
            .await
            .map_err(engine_refusal)?;
        self.record_auth(host, instance_id, state.clone())?;
        let watching = host.clone();
        let id = instance_id.to_owned();
        let flow = state.flow_id.clone();
        let task = tokio::spawn(async move { watch_auth(watching, id, flow, rx).await });
        host.track(&task);
        Ok(state)
    }

    pub async fn auth_cancel(
        &self,
        host: &Host,
        instance_id: &str,
        flow_id: &str,
    ) -> Result<ProviderAuthState, ProviderRefusal> {
        let (instance, factory) = self.lookup(instance_id)?;
        let state = factory
            .auth_cancel(&target_of(&instance), flow_id)
            .await
            .map_err(engine_refusal)?;
        self.record_auth(host, instance_id, state.clone())?;
        Ok(state)
    }

    pub async fn auth_logout(
        &self,
        host: &Host,
        instance_id: &str,
    ) -> Result<ProviderAuthState, ProviderRefusal> {
        let (instance, factory) = self.lookup(instance_id)?;
        let state = factory
            .auth_logout(&target_of(&instance))
            .await
            .map_err(engine_refusal)?;
        self.record_auth(host, instance_id, state.clone())?;
        let _ = self.refresh(host, Some(instance_id)).await;
        Ok(state)
    }

    /// `provider_install_start` (per driver): a running install of the driver is returned.
    pub async fn install_start(
        &self,
        host: &Host,
        instance_id: &str,
    ) -> Result<ProviderInstallState, ProviderRefusal> {
        let (instance, factory) = self.lookup(instance_id)?;
        let running = self
            .state
            .lock()
            .expect("providers")
            .installs
            .get(&instance.driver)
            .filter(|s| install_running(&s.phase))
            .cloned();
        if let Some(running) = running {
            return Ok(running);
        }
        let (tx, rx) = mpsc::unbounded_channel();
        let state = factory
            .install_start(None, tx)
            .await
            .map_err(engine_refusal)?;
        self.record_install(host, &instance.driver, state.clone())?;
        let watching = host.clone();
        let driver = instance.driver.clone();
        let operation = state.operation_id.clone();
        let task =
            tokio::spawn(async move { watch_install(watching, driver, operation, rx).await });
        host.track(&task);
        Ok(state)
    }

    pub async fn install_cancel(
        &self,
        host: &Host,
        instance_id: &str,
        operation_id: &str,
    ) -> Result<ProviderInstallState, ProviderRefusal> {
        let (instance, factory) = self.lookup(instance_id)?;
        let state = factory
            .install_cancel(operation_id)
            .await
            .map_err(engine_refusal)?;
        self.record_install(host, &instance.driver, state.clone())?;
        Ok(state)
    }

    #[allow(clippy::type_complexity)]
    fn lookup(
        &self,
        instance_id: &str,
    ) -> Result<(ProviderInstance, Arc<dyn EngineFactory>), ProviderRefusal> {
        let state = self.state.lock().expect("providers");
        state
            .instances
            .iter()
            .find(|i| i.instance_id == instance_id)
            .and_then(|i| Some((i.clone(), self.factories.get(&i.driver)?.clone())))
            .ok_or_else(|| {
                ProviderRefusal::NotFound(format!("No provider instance {instance_id}."))
            })
    }

    /// Store a sign-in state the driver answered for this instance; one for another instance is
    /// refused, never fixed up.
    fn record_auth(
        &self,
        host: &Host,
        instance_id: &str,
        state: ProviderAuthState,
    ) -> Result<(), ProviderRefusal> {
        if state.instance_id.as_str() != instance_id {
            return Err(ProviderRefusal::Internal(
                "the driver answered for another provider instance".into(),
            ));
        }
        self.state
            .lock()
            .expect("providers")
            .auth
            .insert(instance_id.to_owned(), state);
        self.publish(host);
        Ok(())
    }

    fn record_install(
        &self,
        host: &Host,
        driver: &str,
        state: ProviderInstallState,
    ) -> Result<(), ProviderRefusal> {
        if state.driver != driver {
            return Err(ProviderRefusal::Internal(
                "the driver answered for another provider kind".into(),
            ));
        }
        self.state
            .lock()
            .expect("providers")
            .installs
            .insert(driver.to_owned(), state);
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
                setup: Some(factory.setup()),
                capabilities: factory.capabilities(),
                probe,
                auth_flow: state.auth.get(&instance.instance_id).cloned(),
                install: state.installs.get(&instance.driver).cloned(),
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

/// Later phases of one sign-in flow; an update of an older flow or another instance is dropped.
async fn watch_auth(
    host: Host,
    instance_id: String,
    flow_id: Option<String>,
    mut rx: mpsc::UnboundedReceiver<ProviderAuthState>,
) {
    while let Some(state) = rx.recv().await {
        let providers = &host.inner.providers;
        if state.instance_id.as_str() != instance_id {
            tracing::warn!(instance = %instance_id, "sign-in update for another instance dropped");
            continue;
        }
        let current = {
            let s = providers.state.lock().expect("providers");
            s.auth
                .get(&instance_id)
                .is_some_and(|a| a.flow_id == flow_id)
        };
        if !current {
            continue;
        }
        let succeeded = state.phase == ProviderAuthPhase::Succeeded;
        let _ = providers.record_auth(&host, &instance_id, state);
        if succeeded {
            let _ = providers.refresh(&host, Some(&instance_id)).await;
        }
    }
}

/// Later phases of one install; an update of an older operation is dropped.
async fn watch_install(
    host: Host,
    driver: String,
    operation_id: Option<String>,
    mut rx: mpsc::UnboundedReceiver<ProviderInstallState>,
) {
    while let Some(state) = rx.recv().await {
        let providers = &host.inner.providers;
        let current = {
            let s = providers.state.lock().expect("providers");
            s.installs
                .get(&driver)
                .is_some_and(|i| i.operation_id == operation_id)
        };
        if !current {
            continue;
        }
        let succeeded = state.phase == ProviderInstallPhase::Succeeded;
        if providers.record_install(&host, &driver, state).is_err() {
            tracing::warn!(%driver, "install update for another provider kind dropped");
            continue;
        }
        if succeeded {
            let _ = providers.refresh(&host, None).await;
        }
    }
}

fn auth_running(phase: &ProviderAuthPhase) -> bool {
    matches!(
        phase,
        ProviderAuthPhase::Starting | ProviderAuthPhase::Waiting | ProviderAuthPhase::Verifying
    )
}

fn install_running(phase: &ProviderInstallPhase) -> bool {
    matches!(
        phase,
        ProviderInstallPhase::Downloading
            | ProviderInstallPhase::Extracting
            | ProviderInstallPhase::Verifying
    )
}

fn target_of(instance: &ProviderInstance) -> ProviderTarget {
    ProviderTarget {
        instance_id: ProviderInstanceId::new(instance.instance_id.clone()),
        // Instances carry no launch settings yet: the driver's default binary and environment.
        launch: None,
    }
}

fn idle_auth(
    instance_id: &str,
    methods: Vec<goat2_contracts::ProviderAuthMethod>,
) -> ProviderAuthState {
    ProviderAuthState {
        instance_id: ProviderInstanceId::new(instance_id.to_owned()),
        phase: ProviderAuthPhase::Idle,
        flow_id: None,
        authorization_url: None,
        expires_at: None,
        message: None,
        methods: Some(methods),
        interaction: None,
        credential_owner: None,
    }
}

fn engine_refusal(err: EngineError) -> ProviderRefusal {
    match err {
        EngineError::Unsupported(what) => ProviderRefusal::NotAvailable(format!(
            "This provider does not support {what} from GOAT."
        )),
        other => ProviderRefusal::Internal(other.to_string()),
    }
}
