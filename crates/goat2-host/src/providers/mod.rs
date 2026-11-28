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
/// Folder under the data dir that holds each non-default instance's private home.
const HOMES: &str = "provider-homes";
/// Upper bound on one driver's probe; a slower probe is reported as timed out.
const PROBE_DEADLINE: Duration = Duration::from_secs(30);
/// The message of a row whose probe is still running.
const CHECKING: &str = "Checking status…";

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
    /// Per-instance generation, bumped by a settings change and by the start of each refresh: a
    /// probe result is applied only if its instance's generation did not move meanwhile.
    gens: HashMap<String, u64>,
    /// Set once every listed instance has a row (a probe result or a Checking row): before
    /// that nothing is published (no partial first list). Probes start on demand.
    ready: bool,
}

pub struct Providers {
    path: PathBuf,
    /// `<dataDir>/provider-homes`: one private folder per non-default instance.
    homes: PathBuf,
    factories: BTreeMap<String, Arc<dyn EngineFactory>>,
    state: Mutex<State>,
    list: watch::Sender<ProviderList>,
    /// Set by the first subscription, which starts the initial probes.
    initial_probe: std::sync::atomic::AtomicBool,
}

impl Providers {
    /// `factories`: driver kind (v1 `ProviderDriverKind` slug) -> its factory.
    pub fn open(data_dir: &Path, factories: BTreeMap<String, Arc<dyn EngineFactory>>) -> Self {
        let path = data_dir.join(FILE);
        // An unreadable file is kept aside under a timestamped name, never overwritten.
        let set_aside = |why: &dyn std::fmt::Display| {
            let aside = path.with_extension(format!(
                "json.unreadable-{}",
                crate::util::now_rfc3339().replace(':', "-")
            ));
            tracing::error!(%why, aside = %aside.display(), "provider instances unreadable; using defaults");
            let _ = std::fs::rename(&path, &aside);
        };
        let mut instances: Vec<ProviderInstance> = match std::fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or_else(|err| {
                set_aside(&err);
                Vec::new()
            }),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Vec::new(),
            Err(err) => {
                set_aside(&err);
                Vec::new()
            }
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
            homes: data_dir.join(HOMES),
            factories,
            state: Mutex::new(State {
                instances,
                probes: HashMap::new(),
                auth: HashMap::new(),
                installs: HashMap::new(),
                gens: HashMap::new(),
                ready: false,
            }),
            list: watch::channel(None).0,
            initial_probe: std::sync::atomic::AtomicBool::new(false),
        }
    }

    pub fn subscribe(&self) -> watch::Receiver<ProviderList> {
        self.list.subscribe()
    }

    /// True exactly once: the caller starts the initial probes.
    pub fn claim_initial_probe(&self) -> bool {
        !self
            .initial_probe
            .swap(true, std::sync::atomic::Ordering::SeqCst)
    }

    /// The latest published list (`None` before the first probes finished).
    pub fn current(&self) -> ProviderList {
        self.list.borrow().clone()
    }

    /// The factory a thread's engine starts with (the factory registry: provider instance ->
    /// its driver) and the instance it runs as, or why it cannot start (v1 refuses a provider
    /// that is off or unknown).
    pub fn factory_for_start(
        &self,
        instance_id: &str,
    ) -> Result<(Arc<dyn EngineFactory>, ProviderTarget), String> {
        let instance = {
            let state = self.state.lock().expect("providers");
            state
                .instances
                .iter()
                .find(|i| i.instance_id == instance_id && valid_instance_id(&i.instance_id))
                .cloned()
        };
        let Some(instance) = instance else {
            return Err(format!("provider {instance_id} is not set up in this host"));
        };
        if !instance.enabled {
            return Err(format!("provider {instance_id} is turned off in settings"));
        }
        let factory = self
            .factories
            .get(&instance.driver)
            .cloned()
            .ok_or_else(|| format!("this host has no {} driver", instance.driver))?;
        // Folder work outside the providers lock.
        Ok((factory, self.target_of(&instance)?))
    }

    /// Refuse an instance id no listed instance has (before any probe starts).
    pub fn check_listed(&self, instance_id: &str) -> Result<(), ProviderRefusal> {
        let state = self.state.lock().expect("providers");
        if state
            .instances
            .iter()
            .any(|i| i.instance_id == instance_id && self.listed(i))
        {
            Ok(())
        } else {
            Err(ProviderRefusal::NotFound(format!(
                "No provider instance {instance_id}."
            )))
        }
    }

    /// Probe one instance (or every listed one) again, then publish. Slow: callers that answer
    /// a command run it in a task (it must never hold the command lock).
    pub async fn refresh(&self, host: &Host, only: Option<&str>) -> Result<(), ProviderRefusal> {
        let targets: Vec<(ProviderInstance, u64)> = {
            let mut guard = self.state.lock().expect("providers");
            let state = &mut *guard;
            let listed = state.instances.iter().filter(|i| self.listed(i));
            let picked: Vec<ProviderInstance> = match only {
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
            };
            picked
                .into_iter()
                .map(|i| {
                    let generation = state.gens.entry(i.instance_id.clone()).or_default();
                    *generation += 1;
                    let generation = *generation;
                    (i, generation)
                })
                .collect()
        };
        let probes =
            futures_util::future::join_all(targets.iter().map(|(i, generation)| async move {
                let factory = self.factories[&i.driver].as_ref();
                // A turned-off instance gets no folder; one whose home cannot be prepared is
                // never probed (it would fall back to the shared home's credentials).
                let (probe, target) = if !i.enabled {
                    (
                        status_only(ServerProviderState::Disabled, "Turned off in settings."),
                        None,
                    )
                } else {
                    match self.target_of(i) {
                        Ok(target) => (probe(factory, &target).await, Some(target)),
                        Err(why) => (status_only(ServerProviderState::Error, &why), None),
                    }
                };
                // Sign-in methods for an instance with no flow yet (v1 lists them idle).
                // Bounded like the probe: a hanging driver never stalls the whole list.
                let methods = match target {
                    Some(target) if factory.setup().can_authenticate => {
                        tokio::time::timeout(PROBE_DEADLINE, factory.auth_methods(&target))
                            .await
                            .ok()
                            .and_then(Result::ok)
                    }
                    _ => None,
                };
                (i.instance_id.clone(), *generation, probe, methods)
            }))
            .await;
        {
            let mut state = self.state.lock().expect("providers");
            for (id, generation, probe, methods) in probes {
                // A settings change or a newer refresh since this probe started wins.
                if state.gens.get(&id) != Some(&generation) {
                    continue;
                }
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
            // Ready only when every listed instance has a row: the initial probe's results can
            // be discarded by a newer refresh or setting, and an empty or partial first list
            // would read as "no providers".
            if !state.ready {
                let ready = state
                    .instances
                    .iter()
                    .filter(|i| self.listed(i))
                    .all(|i| state.probes.contains_key(&i.instance_id));
                state.ready = ready;
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
        let target = self
            .target_of(&instance)
            .map_err(ProviderRefusal::Internal)?;
        let state = clean_auth(
            instance_id,
            bounded(factory.auth_start(&target, method_id, tx)).await?,
        );
        self.record_auth(host, instance_id, state.clone())?;
        if state.phase == ProviderAuthPhase::Succeeded {
            self.reprobe_after_sign_in(host, instance_id);
        }
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
        let target = self
            .target_of(&instance)
            .map_err(ProviderRefusal::Internal)?;
        let state = clean_auth(
            instance_id,
            bounded(factory.auth_cancel(&target, flow_id)).await?,
        );
        // Cancelling an older flow never hides the one that runs now.
        self.record_auth_if(host, instance_id, state.clone(), |current| {
            current.is_none_or(|c| c.flow_id.as_deref() == Some(flow_id))
        })?;
        Ok(state)
    }

    /// `provider_auth_respond`: answer what the instance's running flow waits for. The
    /// response (an API key, terminal input) goes straight to the driver and is dropped: never
    /// logged or stored. An answer for an older flow never replaces the running one's state.
    pub async fn auth_respond(
        &self,
        host: &Host,
        instance_id: &str,
        flow_id: &str,
        interaction_id: &str,
        response: goat2_contracts::ProviderAuthResponse,
    ) -> Result<ProviderAuthState, ProviderRefusal> {
        let (instance, factory) = self.lookup(instance_id)?;
        // Only the instance's running flow takes an answer, so a secret is not sent for a flow
        // that ended, was replaced, or did not survive a restart. The check and the driver call
        // are not one step (a flow can end in between), so a driver still refuses flows it does
        // not hold.
        let current = self
            .state
            .lock()
            .expect("providers")
            .auth
            .get(instance_id)
            .cloned();
        if !current
            .as_ref()
            .is_some_and(|c| c.flow_id.as_deref() == Some(flow_id) && auth_running(&c.phase))
        {
            return Err(ProviderRefusal::NotFound(format!(
                "No running sign-in flow {flow_id} for provider instance {instance_id}."
            )));
        }
        let target = self
            .target_of(&instance)
            .map_err(ProviderRefusal::Internal)?;
        let state = clean_auth(
            instance_id,
            bounded(factory.auth_respond(&target, flow_id, interaction_id, response)).await?,
        );
        // An answer for another flow is refused, never stored: storing it would orphan the
        // running flow (its watcher keeps only updates for its own flow id).
        if state.flow_id.as_deref() != Some(flow_id) {
            return Err(ProviderRefusal::Internal(
                "the driver answered for another sign-in flow".into(),
            ));
        }
        // Stored only while that flow still runs: a terminal update recorded meanwhile wins.
        let stored = self.record_auth_if(host, instance_id, state.clone(), |current| {
            current.is_some_and(|c| c.flow_id.as_deref() == Some(flow_id) && auth_running(&c.phase))
        })?;
        // Signed in at once (e.g. a key checked on submit): the provider row is checked again,
        // as watch_auth does for a success that arrives later.
        if stored && state.phase == ProviderAuthPhase::Succeeded {
            self.reprobe_after_sign_in(host, instance_id);
        }
        Ok(state)
    }

    /// Re-probe one instance in a task after a sign-in succeeded (a command must not wait on
    /// a probe).
    fn reprobe_after_sign_in(&self, host: &Host, instance_id: &str) {
        let probing = host.clone();
        let id = instance_id.to_owned();
        let task = tokio::spawn(async move {
            let _ = probing.inner.providers.refresh(&probing, Some(&id)).await;
        });
        host.track(&task);
    }

    pub async fn auth_logout(
        &self,
        host: &Host,
        instance_id: &str,
    ) -> Result<ProviderAuthState, ProviderRefusal> {
        let (instance, factory) = self.lookup(instance_id)?;
        let target = self
            .target_of(&instance)
            .map_err(ProviderRefusal::Internal)?;
        let state = clean_auth(instance_id, bounded(factory.auth_logout(&target)).await?);
        self.record_auth(host, instance_id, state.clone())?;
        // Re-probed in a task: this answers a command and must not wait on a probe.
        let probing = host.clone();
        let id = instance_id.to_owned();
        let task = tokio::spawn(async move {
            let _ = probing.inner.providers.refresh(&probing, Some(&id)).await;
        });
        host.track(&task);
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
        let state = bounded(factory.install_start(None, tx)).await?;
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
        let state = bounded(factory.install_cancel(operation_id)).await?;
        // Cancelling an older operation never replaces the running one's state.
        self.record_install_if(host, &instance.driver, state.clone(), |current| {
            current.is_none_or(|i| i.operation_id.as_deref() == Some(operation_id))
        })?;
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
            .find(|i| i.instance_id == instance_id && valid_instance_id(&i.instance_id))
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
        self.record_auth_if(host, instance_id, state, |_| true)
            .map(|_| ())
    }

    /// [Self::record_auth] when `keep` accepts the current state, checked and stored under one
    /// lock. Returns whether it was stored. A sign-in URL that is not a valid http(s) URL is
    /// dropped from the state (the phase stays): it would not serialize and would stop the list.
    fn record_auth_if(
        &self,
        host: &Host,
        instance_id: &str,
        mut state: ProviderAuthState,
        keep: impl FnOnce(Option<&ProviderAuthState>) -> bool,
    ) -> Result<bool, ProviderRefusal> {
        if state.instance_id.as_str() != instance_id {
            return Err(ProviderRefusal::Internal(
                "the driver answered for another provider instance".into(),
            ));
        }
        state = clean_auth(instance_id, state);
        {
            let mut s = self.state.lock().expect("providers");
            if !keep(s.auth.get(instance_id)) {
                return Ok(false);
            }
            s.auth.insert(instance_id.to_owned(), state);
        }
        self.publish(host);
        Ok(true)
    }

    fn record_install(
        &self,
        host: &Host,
        driver: &str,
        state: ProviderInstallState,
    ) -> Result<(), ProviderRefusal> {
        self.record_install_if(host, driver, state, |_| true)
            .map(|_| ())
    }

    /// [Self::record_install] when `keep` accepts the current state, under one lock.
    fn record_install_if(
        &self,
        host: &Host,
        driver: &str,
        state: ProviderInstallState,
        keep: impl FnOnce(Option<&ProviderInstallState>) -> bool,
    ) -> Result<bool, ProviderRefusal> {
        if state.driver != driver {
            return Err(ProviderRefusal::Internal(
                "the driver answered for another provider kind".into(),
            ));
        }
        {
            let mut s = self.state.lock().expect("providers");
            if !keep(s.installs.get(driver)) {
                return Ok(false);
            }
            s.installs.insert(driver.to_owned(), state);
        }
        self.publish(host);
        Ok(true)
    }

    /// Add or change an instance (v1 settings `providerInstances` upsert), save, publish.
    pub fn set_instance(&self, host: &Host, next: ProviderInstance) -> Result<(), ProviderRefusal> {
        // The id names the instance's home folder: v1's slug rule, checked before any path.
        if !valid_instance_id(&next.instance_id) {
            return Err(ProviderRefusal::Invalid(
                "instanceId must start with a letter and use only letters, digits, '_' or '-' (at most 64)".into(),
            ));
        }
        if !self.factories.contains_key(&next.driver) {
            return Err(ProviderRefusal::DriverUnavailable(format!(
                "This GOAT 2 build has no {} driver yet.",
                next.driver
            )));
        }
        {
            let mut state = self.state.lock().expect("providers");
            // Ids name folders, and macOS folders ignore case: two ids that differ only in
            // case would share one home (and its credentials).
            if let Some(other) = state.instances.iter().find(|i| {
                i.instance_id != next.instance_id
                    && i.instance_id.eq_ignore_ascii_case(&next.instance_id)
            }) {
                return Err(ProviderRefusal::Invalid(format!(
                    "instanceId {} differs from the existing {} only in letter case",
                    next.instance_id, other.instance_id
                )));
            }
            // Saved first: a failed save changes nothing.
            let mut instances = state.instances.clone();
            match instances
                .iter_mut()
                .find(|i| i.instance_id == next.instance_id)
            {
                Some(existing) => *existing = next.clone(),
                None => instances.push(next.clone()),
            }
            save(&self.path, &instances).map_err(|e| {
                ProviderRefusal::Internal(format!("provider instances not saved: {e}"))
            })?;
            state.instances = instances;
            *state.gens.entry(next.instance_id.clone()).or_default() += 1;
            if !next.enabled {
                state.probes.insert(
                    next.instance_id.clone(),
                    status_only(ServerProviderState::Disabled, "Turned off in settings."),
                );
            } else if state
                .probes
                .get(&next.instance_id)
                .is_none_or(|p| p.status == ServerProviderState::Disabled)
            {
                // Turned back on, or new: listed as being checked until its probe lands (a
                // frame is the whole list, so the row must not vanish meanwhile).
                state.probes.insert(
                    next.instance_id.clone(),
                    status_only(ServerProviderState::Warning, CHECKING),
                );
            }
        }
        self.publish(host);
        Ok(())
    }

    /// Rebuild the list and push it when it changed. Built and sent under the state lock, so
    /// an older list never replaces a newer one. Nothing is published before the first list
    /// has a row for every listed instance.
    pub fn publish(&self, host: &Host) {
        // Order: providers state, then sign-in links, then store reads (no path takes them the
        // other way round), so the links match the state the list is built from.
        let state = self.state.lock().expect("providers");
        if !state.ready {
            return;
        }
        let links = host.signin_links();
        let entries = self.entries(host, &state, &links);
        self.list.send_if_modified(|current| {
            if current.as_ref() == Some(&entries) {
                false
            } else {
                *current = Some(entries);
                true
            }
        });
    }

    /// Rows of listed instances that have a probe result; one still waiting for its first probe
    /// is left out (no placeholder row).
    fn entries(
        &self,
        host: &Host,
        state: &State,
        links: &[crate::core::SigninLink],
    ) -> Vec<ServerProviderEntry> {
        let mut out = Vec::new();
        for instance in &state.instances {
            if !valid_instance_id(&instance.instance_id) {
                continue; // Kept in the file, never listed or given a home.
            }
            let Some(factory) = self.factories.get(&instance.driver) else {
                continue; // A driver this build does not have: kept in the file, not listed.
            };
            let Some(probe) = state.probes.get(&instance.instance_id) else {
                continue;
            };
            let mut probe = probe.clone();
            if probe.auth.action.is_none()
                // Newest link first; one that is not a usable sign-in URL is never attached (it
                // would not serialize and would stop the whole frame).
                && let Some(link) = links.iter().rev().find(|l| {
                    goat2_contracts::serde_util::sign_in_url::check(&l.url).is_ok()
                        && host.store().card(&l.thread_id).is_some_and(|c| {
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
        out
    }
}

async fn probe(factory: &dyn EngineFactory, target: &ProviderTarget) -> ProviderProbeResult {
    match tokio::time::timeout(PROBE_DEADLINE, factory.probe_instance(target)).await {
        Ok(Ok(mut probe)) => {
            // A sign-in action with an unusable URL would stop the whole list: dropped.
            if probe
                .auth
                .action
                .as_ref()
                .is_some_and(|a| !valid_sign_in_url(&a.url))
            {
                tracing::warn!("a probe sign-in URL that is not a valid http(s) URL was dropped");
                probe.auth.action = None;
            }
            probe
        }
        Ok(Err(EngineError::Unsupported(_))) => status_only(
            ServerProviderState::Warning,
            "This driver cannot report its status yet.",
        ),
        Ok(Err(err)) => status_only(ServerProviderState::Error, &err.to_string()),
        Err(_) => status_only(ServerProviderState::Error, "The status check timed out."),
    }
}

/// A row with only a state and a reason: nothing about install, sign-in or models is known.
/// `installed` stays true because v1's UI reads `installed:false` as "not found", which such a
/// row does not know (v1 shows these as "needs attention").
fn status_only(status: ServerProviderState, message: &str) -> ProviderProbeResult {
    ProviderProbeResult {
        installed: true,
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
    use std::io::Write;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(instances).map_err(std::io::Error::other)?;
    let mut file = std::fs::File::create(&tmp)?;
    file.write_all(&body)?;
    file.sync_all()?;
    drop(file);
    std::fs::rename(&tmp, path)?;
    // The rename itself survives a crash only once the folder is synced.
    if let Some(dir) = path.parent() {
        std::fs::File::open(dir)?.sync_all()?;
    }
    Ok(())
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
        let succeeded = state.phase == ProviderAuthPhase::Succeeded;
        // Stored only while this is still the instance's current flow (one lock). Once the flow
        // has a terminal state (e.g. the Cancelled that auth_cancel recorded), a running phase
        // the driver queued before it never brings the flow back.
        let running = auth_running(&state.phase);
        let stored = providers
            .record_auth_if(&host, &instance_id, state, |c| {
                c.is_some_and(|a| a.flow_id == flow_id && !(running && auth_terminal(&a.phase)))
            })
            .unwrap_or(false);
        if stored && succeeded {
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
        let succeeded = state.phase == ProviderInstallPhase::Succeeded;
        // Same rule as sign-in: a terminal install state is never replaced by a running phase
        // queued before it.
        let running = install_running(&state.phase);
        let stored = match providers.record_install_if(&host, &driver, state, |c| {
            c.is_some_and(|i| {
                i.operation_id == operation_id && !(running && install_terminal(&i.phase))
            })
        }) {
            Ok(stored) => stored,
            Err(_) => {
                tracing::warn!(%driver, "install update for another provider kind dropped");
                continue;
            }
        };
        if stored && succeeded {
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

fn auth_terminal(phase: &ProviderAuthPhase) -> bool {
    matches!(
        phase,
        ProviderAuthPhase::Succeeded | ProviderAuthPhase::Failed | ProviderAuthPhase::Cancelled
    )
}

fn install_terminal(phase: &ProviderInstallPhase) -> bool {
    matches!(
        phase,
        ProviderInstallPhase::Succeeded
            | ProviderInstallPhase::Failed
            | ProviderInstallPhase::Cancelled
    )
}

impl Providers {
    /// Listed: a valid id and a driver this build has.
    fn listed(&self, instance: &ProviderInstance) -> bool {
        valid_instance_id(&instance.instance_id) && self.factories.contains_key(&instance.driver)
    }

    /// The instance as a driver runs it. A non-default instance gets its private home,
    /// created (mode 0700) before it is handed over; the default instance (id = driver kind)
    /// uses the driver's shared home. A home is never deleted here: credentials stay until the
    /// person signs out. Err when the home cannot be prepared (the message names no path):
    /// the caller reports it and never falls back to the shared home.
    fn target_of(&self, instance: &ProviderInstance) -> Result<ProviderTarget, String> {
        if !valid_instance_id(&instance.instance_id) {
            return Err(format!(
                "provider {} is not a valid instance id",
                instance.instance_id
            ));
        }
        let home = if instance.instance_id == instance.driver {
            None
        } else {
            let home = self.homes.join(&instance.instance_id);
            if let Err(err) = prepare_home(&self.homes, &home) {
                // No path in the log: home paths stay out of tracing.
                tracing::warn!(instance = %instance.instance_id, error = %err, "provider home not prepared");
                return Err("Could not prepare this provider's private home folder.".into());
            }
            Some(home)
        };
        Ok(ProviderTarget {
            instance_id: ProviderInstanceId::new(instance.instance_id.clone()),
            // Instances carry no launch settings yet: the driver's default binary and environment.
            launch: None,
            home,
            // Provider settings carry no shared home yet: the driver's default.
            shared_home: None,
        })
    }
}

/// v1 `ProviderInstanceId` (providerInstance.ts slug): a letter, then letters, digits, `_` or
/// `-`, at most 64 characters. No dot, slash or NUL can reach the home path.
pub fn valid_instance_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic())
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// Create `root` and `home` (its direct child) as private folders, or check existing ones:
/// each must be a real folder, never a symlink (which could point the home outside
/// `root`), and ends up mode 0700. Errors name no path.
fn prepare_home(root: &Path, home: &Path) -> std::io::Result<()> {
    for dir in [root, home] {
        plain_dir_or_absent(dir)?;
        let mut builder = std::fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(dir) {
            Ok(()) => {}
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(err) => return Err(err),
        }
        // Checked again after creating: nothing may have swapped in a link meanwhile.
        plain_dir_or_absent(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
    }
    Ok(())
}

fn plain_dir_or_absent(dir: &Path) -> std::io::Result<()> {
    match std::fs::symlink_metadata(dir) {
        Ok(meta) if meta.file_type().is_symlink() || !meta.is_dir() => Err(std::io::Error::other(
            "a provider home folder is a link or not a folder",
        )),
        Ok(_) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(err),
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

/// Upper bound on one driver sign-in or install call made while a command waits on it.
const DRIVER_CALL_DEADLINE: Duration = Duration::from_secs(30);

/// A driver call a command waits on, bounded so a hanging driver cannot hold the command lock.
async fn bounded<T>(
    call: impl std::future::Future<Output = Result<T, EngineError>>,
) -> Result<T, ProviderRefusal> {
    match tokio::time::timeout(DRIVER_CALL_DEADLINE, call).await {
        Ok(result) => result.map_err(engine_refusal),
        Err(_) => Err(ProviderRefusal::Internal(
            "the provider did not answer in time".into(),
        )),
    }
}

/// The contract's sign-in URL rule (trimmed http(s)), as checked before serializing.
fn valid_sign_in_url(url: &str) -> bool {
    goat2_contracts::serde_util::sign_in_url::check(url).is_ok()
}

/// A driver's sign-in state with an unusable URL dropped (the phase stays): such a URL would
/// not serialize and would stop the whole providers list and the command reply. A browser or
/// device-code interaction with such a URL is dropped whole.
fn clean_auth(instance_id: &str, mut state: ProviderAuthState) -> ProviderAuthState {
    if state
        .authorization_url
        .as_deref()
        .is_some_and(|u| !valid_sign_in_url(u))
    {
        tracing::warn!(instance = %instance_id, "a sign-in URL that is not a valid http(s) URL was dropped");
        state.authorization_url = None;
    }
    let bad_interaction = match &state.interaction {
        Some(Some(
            goat2_contracts::ProviderAuthInteraction::Browser { url, .. }
            | goat2_contracts::ProviderAuthInteraction::DeviceCode { url, .. },
        )) => !valid_sign_in_url(url),
        _ => false,
    };
    if bad_interaction {
        tracing::warn!(instance = %instance_id, "a sign-in interaction whose URL is not a valid http(s) URL was dropped");
        state.interaction = None;
    }
    state
}
