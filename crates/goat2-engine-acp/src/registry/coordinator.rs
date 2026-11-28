//! Runtime coordination between registry sessions and probes, from v1
//! `AcpRegistryRuntimeCoordinator.ts` (all 423 lines) at 916b5ccc1b2.
//!
//! A foreground session start for an agent stops (and keeps from starting) a background probe of
//! the same agent; session-list mutations run one at a time; available commands and live
//! configuration are published per provider instance (configuration with a revision); and an ACP
//! URL sign-in waits up to ten minutes for the user's consent.
//!
//! The command and configuration payloads belong to the probe code, so they are type parameters
//! (JSON by default). v1's unbounded PubSub becomes a broadcast channel of [UPDATE_CAPACITY];
//! a watcher that falls that far behind skips to the newest updates.

use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use futures::{Stream, StreamExt};
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

use super::contracts::{AcpRegistryAcceptUrlAuthInput, AcpRegistryUrlAuthAction};

/// v1 `AcpRegistryRuntimeCoordinator.ts:51`.
pub const URL_AUTH_ACTION_TTL: Duration = Duration::from_secs(10 * 60);
pub const UPDATE_CAPACITY: usize = 1024;

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// `DateTime.formatIso`: `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub fn format_iso(time: SystemTime) -> String {
    let since = time.duration_since(UNIX_EPOCH).unwrap_or_default();
    let secs = since.as_secs() as i64;
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        rem / 3_600,
        rem % 3_600 / 60,
        rem % 60,
        since.subsec_millis()
    )
}

/// A published live configuration and its revision (v1 `LiveConfigurationEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct LiveConfigurationSnapshot<L> {
    pub configuration: Option<L>,
    pub revision: u64,
}

#[derive(Debug, Clone)]
struct LiveUpdate<L> {
    instance_id: String,
    configuration: L,
    revision: u64,
}

struct LiveState<L> {
    next_revision: u64,
    entries: HashMap<String, (L, u64)>,
}

struct PendingUrlAuth {
    action: AcpRegistryUrlAuthAction,
    consent: Option<oneshot::Sender<bool>>,
    token: u64,
    expires_at: tokio::time::Instant,
}

/// v1 `AcpRegistryRuntimeCoordinator` service.
pub struct RuntimeCoordinator<C = Value, L = Value> {
    foreground_starts: broadcast::Sender<String>,
    active_foreground: Mutex<HashMap<String, usize>>,
    commands_updates: broadcast::Sender<(String, C)>,
    commands: Mutex<HashMap<String, C>>,
    live_updates: broadcast::Sender<LiveUpdate<L>>,
    live: Mutex<LiveState<L>>,
    url_updates: broadcast::Sender<(String, Option<AcpRegistryUrlAuthAction>)>,
    pending_url: Mutex<HashMap<String, PendingUrlAuth>>,
    url_permit: tokio::sync::Mutex<()>,
    session_mutation: tokio::sync::Mutex<()>,
    next_token: std::sync::atomic::AtomicU64,
}

impl<C: Clone + Send + 'static, L: Clone + Send + 'static> Default for RuntimeCoordinator<C, L> {
    fn default() -> Self {
        Self {
            foreground_starts: broadcast::channel(UPDATE_CAPACITY).0,
            active_foreground: Mutex::default(),
            commands_updates: broadcast::channel(UPDATE_CAPACITY).0,
            commands: Mutex::default(),
            live_updates: broadcast::channel(UPDATE_CAPACITY).0,
            live: Mutex::new(LiveState {
                next_revision: 0,
                entries: HashMap::new(),
            }),
            url_updates: broadcast::channel(UPDATE_CAPACITY).0,
            pending_url: Mutex::default(),
            url_permit: tokio::sync::Mutex::new(()),
            session_mutation: tokio::sync::Mutex::new(()),
            next_token: Default::default(),
        }
    }
}

/// Lowers the foreground count when the start ends or is dropped (v1 `acquireUseRelease`).
struct ForegroundGuard<'a> {
    counts: &'a Mutex<HashMap<String, usize>>,
    agent_id: String,
}
impl Drop for ForegroundGuard<'_> {
    fn drop(&mut self) {
        let mut counts = lock(self.counts);
        let remaining = counts
            .get(&self.agent_id)
            .copied()
            .unwrap_or(1)
            .saturating_sub(1);
        if remaining == 0 {
            counts.remove(&self.agent_id);
        } else {
            counts.insert(self.agent_id.clone(), remaining);
        }
    }
}

/// Clears this request's pending sign-in when it ends or is dropped (v1 `ensuring(cleanup)`).
struct UrlAuthCleanup<'a> {
    pending: &'a Mutex<HashMap<String, PendingUrlAuth>>,
    updates: &'a broadcast::Sender<(String, Option<AcpRegistryUrlAuthAction>)>,
    instance_id: String,
    token: u64,
}
impl Drop for UrlAuthCleanup<'_> {
    fn drop(&mut self) {
        let mut pending = lock(self.pending);
        if pending
            .get(&self.instance_id)
            .is_some_and(|p| p.token == self.token)
        {
            pending.remove(&self.instance_id);
            let _ = self.updates.send((self.instance_id.clone(), None));
        }
    }
}

impl<C: Clone + Send + 'static, L: Clone + Send + 'static> RuntimeCoordinator<C, L> {
    pub fn new() -> Self {
        Self::default()
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:144-163`.
    pub async fn with_foreground_startup<T>(
        &self,
        agent_id: &str,
        start: impl Future<Output = T>,
    ) -> T {
        *lock(&self.active_foreground)
            .entry(agent_id.to_owned())
            .or_default() += 1;
        let _guard = ForegroundGuard {
            counts: &self.active_foreground,
            agent_id: agent_id.to_owned(),
        };
        let _ = self.foreground_starts.send(agent_id.to_owned());
        start.await
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:165-183`: None when a foreground start of the agent is
    /// running or begins before the probe finishes (the probe is dropped).
    pub async fn run_background_probe<T>(
        &self,
        agent_id: &str,
        probe: impl Future<Output = T>,
    ) -> Option<T> {
        // Subscribe first so foreground starts cannot slip between the state check and probe.
        let mut starts = self.foreground_starts.subscribe();
        if lock(&self.active_foreground).contains_key(agent_id) {
            return None;
        }
        let foreground_started = async {
            loop {
                match starts.recv().await {
                    Ok(id) if id == agent_id => return,
                    Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => std::future::pending::<()>().await,
                }
            }
        };
        tokio::select! {
            result = probe => Some(result),
            () = foreground_started => None,
        }
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:185-187`.
    pub async fn with_session_mutation<T>(&self, mutation: impl Future<Output = T>) -> T {
        let _held = self.session_mutation.lock().await;
        mutation.await
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:189-195`.
    pub fn clear_available_commands(&self, instance_id: &str) {
        lock(&self.commands).remove(instance_id);
    }
    /// v1 `AcpRegistryRuntimeCoordinator.ts:197-211`.
    pub fn publish_available_commands(&self, instance_id: &str, commands: C) {
        lock(&self.commands).insert(instance_id.to_owned(), commands.clone());
        let _ = self
            .commands_updates
            .send((instance_id.to_owned(), commands));
    }
    /// v1 `AcpRegistryRuntimeCoordinator.ts:213-216`.
    pub fn available_commands(&self, instance_id: &str) -> Option<C> {
        lock(&self.commands).get(instance_id).cloned()
    }
    /// v1 `AcpRegistryRuntimeCoordinator.ts:218-233`: the current commands, then each update.
    pub fn watch_available_commands(
        &self,
        instance_id: &str,
    ) -> impl Stream<Item = C> + Send + 'static {
        let receiver = self.commands_updates.subscribe();
        let id = instance_id.to_owned();
        subscribe(
            self.available_commands(instance_id),
            receiver,
            move |(i, c)| (i == id).then_some(c),
        )
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:235-242`.
    pub fn clear_live_configuration(&self, instance_id: &str) {
        lock(&self.live).entries.remove(instance_id);
    }
    /// v1 `AcpRegistryRuntimeCoordinator.ts:244-256`: true when nothing newer replaced it.
    pub fn clear_live_configuration_if_revision(&self, instance_id: &str, revision: u64) -> bool {
        let mut live = lock(&self.live);
        match live.entries.get(instance_id) {
            None => true,
            Some((_, r)) if *r != revision => false,
            Some(_) => {
                live.entries.remove(instance_id);
                true
            }
        }
    }
    /// v1 `AcpRegistryRuntimeCoordinator.ts:258-274`.
    pub fn publish_live_configuration(&self, instance_id: &str, configuration: L) {
        let revision = {
            let mut live = lock(&self.live);
            live.next_revision += 1;
            let revision = live.next_revision;
            live.entries
                .insert(instance_id.to_owned(), (configuration.clone(), revision));
            revision
        };
        let _ = self.live_updates.send(LiveUpdate {
            instance_id: instance_id.to_owned(),
            configuration,
            revision,
        });
    }
    /// v1 `AcpRegistryRuntimeCoordinator.ts:276-284`.
    pub fn live_configuration_with_revision(
        &self,
        instance_id: &str,
    ) -> LiveConfigurationSnapshot<L> {
        match lock(&self.live).entries.get(instance_id) {
            None => LiveConfigurationSnapshot {
                configuration: None,
                revision: 0,
            },
            Some((c, r)) => LiveConfigurationSnapshot {
                configuration: Some(c.clone()),
                revision: *r,
            },
        }
    }
    /// v1 `AcpRegistryRuntimeCoordinator.ts:286-289`.
    pub fn live_configuration(&self, instance_id: &str) -> Option<L> {
        self.live_configuration_with_revision(instance_id)
            .configuration
    }
    /// v1 `AcpRegistryRuntimeCoordinator.ts:291-312`: each configuration newer than
    /// `after_revision`, with its revision.
    pub fn watch_live_configuration(
        &self,
        instance_id: &str,
        after_revision: Option<u64>,
    ) -> impl Stream<Item = (L, u64)> + Send + 'static {
        let receiver = self.live_updates.subscribe();
        let mut last = after_revision.unwrap_or(0);
        let current = self.live_configuration_with_revision(instance_id);
        let first = match current.configuration {
            Some(c) if current.revision > last => {
                last = current.revision;
                Some((c, current.revision))
            }
            _ => None,
        };
        let id = instance_id.to_owned();
        subscribe(first, receiver, move |u: LiveUpdate<L>| {
            (u.instance_id == id && u.revision > last).then(|| {
                last = u.revision;
                (u.configuration, u.revision)
            })
        })
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:319-365`: publish the sign-in action (with
    /// `createdAt`/`expiresAt`) and wait for consent; a newer request for the instance declines
    /// this one, and ten minutes without an answer is a decline.
    pub async fn request_url_authentication(
        &self,
        instance_id: &str,
        action: AcpRegistryUrlAuthAction,
    ) -> bool {
        let (consent, answer) = oneshot::channel();
        let token = self
            .next_token
            .fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let created = SystemTime::now();
        let published = AcpRegistryUrlAuthAction {
            created_at: Some(format_iso(created)),
            expires_at: Some(format_iso(created + URL_AUTH_ACTION_TTL)),
            ..action
        };
        let _cleanup = UrlAuthCleanup {
            pending: &self.pending_url,
            updates: &self.url_updates,
            instance_id: instance_id.to_owned(),
            token,
        };
        {
            let _permit = self.url_permit.lock().await;
            let previous = lock(&self.pending_url).insert(
                instance_id.to_owned(),
                PendingUrlAuth {
                    action: published.clone(),
                    consent: Some(consent),
                    token,
                    expires_at: tokio::time::Instant::now() + URL_AUTH_ACTION_TTL,
                },
            );
            if let Some(sender) = previous.and_then(|p| p.consent) {
                let _ = sender.send(false);
            }
            let _ = self
                .url_updates
                .send((instance_id.to_owned(), Some(published)));
        }
        matches!(
            tokio::time::timeout(URL_AUTH_ACTION_TTL, answer).await,
            Ok(Ok(true))
        )
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:367-376`.
    pub fn accept_url_authentication(&self, input: &AcpRegistryAcceptUrlAuthInput) -> bool {
        let mut pending = lock(&self.pending_url);
        let Some(entry) = pending.get_mut(&input.instance_id) else {
            return false;
        };
        if entry.action.elicitation_id != input.elicitation_id {
            return false;
        }
        let Some(consent) = entry.consent.take() else {
            return false;
        };
        if tokio::time::Instant::now() >= entry.expires_at {
            let _ = consent.send(false);
            return false;
        }
        consent.send(true).is_ok()
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:378-382`.
    pub fn url_auth_action(&self, instance_id: &str) -> Option<AcpRegistryUrlAuthAction> {
        lock(&self.pending_url)
            .get(instance_id)
            .map(|p| p.action.clone())
    }

    /// v1 `AcpRegistryRuntimeCoordinator.ts:384-400`: the pending action, then each change
    /// (None when it ends).
    pub fn watch_url_auth_action(
        &self,
        instance_id: &str,
    ) -> impl Stream<Item = Option<AcpRegistryUrlAuthAction>> + Send + 'static {
        let receiver = self.url_updates.subscribe();
        let id = instance_id.to_owned();
        subscribe(
            self.url_auth_action(instance_id).map(Some),
            receiver,
            move |(i, action)| (i == id).then_some(action),
        )
    }
}

/// Current value (if any), then each update `select` keeps; a lagging receiver skips ahead.
fn subscribe<T, U>(
    current: Option<T>,
    receiver: broadcast::Receiver<U>,
    select: impl FnMut(U) -> Option<T> + Send + 'static,
) -> impl Stream<Item = T> + Send + 'static
where
    T: Send + 'static,
    U: Clone + Send + 'static,
{
    let rest = futures::stream::unfold((receiver, select), |(mut rx, mut select)| async move {
        loop {
            match rx.recv().await {
                Ok(update) => {
                    if let Some(item) = select(update) {
                        return Some((item, (rx, select)));
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return None,
            }
        }
    });
    futures::stream::iter(current).chain(rest)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::StreamExt;
    use std::sync::Arc;

    type Coordinator = RuntimeCoordinator<Value, Value>;

    fn action(id: &str) -> AcpRegistryUrlAuthAction {
        AcpRegistryUrlAuthAction {
            elicitation_id: id.into(),
            url: "https://login.example.test".into(),
            message: "Sign in".into(),
            created_at: None,
            expires_at: None,
        }
    }

    #[test]
    fn iso_format_matches_javascript() {
        assert_eq!(format_iso(UNIX_EPOCH), "1970-01-01T00:00:00.000Z");
        let t = UNIX_EPOCH + Duration::from_millis(1_795_919_400_123);
        assert_eq!(format_iso(t), "2026-11-29T02:30:00.123Z");
        assert_eq!(
            format_iso(UNIX_EPOCH + Duration::from_secs(951_782_400)),
            "2000-02-29T00:00:00.000Z"
        );
    }

    #[tokio::test]
    async fn foreground_start_blocks_and_interrupts_background_probes() {
        let c = Arc::new(Coordinator::new());
        // A running foreground start keeps a probe from starting.
        let (release, released) = oneshot::channel::<()>();
        let (started_tx, started) = oneshot::channel::<()>();
        let fg = {
            let c = c.clone();
            tokio::spawn(async move {
                c.with_foreground_startup("a", async {
                    let _ = started_tx.send(());
                    let _ = released.await;
                })
                .await
            })
        };
        started.await.unwrap();
        assert_eq!(c.run_background_probe("a", async { 1 }).await, None);
        assert_eq!(c.run_background_probe("b", async { 2 }).await, Some(2));
        release.send(()).unwrap();
        fg.await.unwrap();
        assert_eq!(c.run_background_probe("a", async { 3 }).await, Some(3));

        // A foreground start that begins mid-probe wins.
        let (probe_running_tx, probe_running) = oneshot::channel::<()>();
        let probe = {
            let c = c.clone();
            tokio::spawn(async move {
                c.run_background_probe("a", async {
                    let _ = probe_running_tx.send(());
                    std::future::pending::<u8>().await
                })
                .await
            })
        };
        probe_running.await.unwrap();
        c.with_foreground_startup("a", async {}).await;
        assert_eq!(probe.await.unwrap(), None);
        assert!(lock(&c.active_foreground).is_empty());
    }

    #[tokio::test]
    async fn commands_and_live_configuration_are_watched_with_revisions() {
        let c = Coordinator::new();
        c.publish_available_commands("i", Value::from(1));
        let mut commands = Box::pin(c.watch_available_commands("i"));
        assert_eq!(commands.next().await, Some(Value::from(1)));
        c.publish_available_commands("other", Value::from(9));
        c.publish_available_commands("i", Value::from(2));
        assert_eq!(commands.next().await, Some(Value::from(2)));
        c.clear_available_commands("i");
        assert_eq!(c.available_commands("i"), None);

        c.publish_live_configuration("i", Value::from("a"));
        let first = c.live_configuration_with_revision("i");
        assert_eq!(first.revision, 1);
        let mut skipped = Box::pin(c.watch_live_configuration("i", Some(1)));
        let mut live = Box::pin(c.watch_live_configuration("i", None));
        assert_eq!(live.next().await, Some((Value::from("a"), 1)));
        c.publish_live_configuration("i", Value::from("b"));
        assert_eq!(live.next().await, Some((Value::from("b"), 2)));
        assert_eq!(skipped.next().await, Some((Value::from("b"), 2)));
        assert!(!c.clear_live_configuration_if_revision("i", 1));
        assert!(c.clear_live_configuration_if_revision("i", 2));
        assert!(c.clear_live_configuration_if_revision("i", 2));
        assert_eq!(c.live_configuration("i"), None);
    }

    #[tokio::test]
    async fn session_mutations_run_one_at_a_time() {
        let c = Arc::new(Coordinator::new());
        let (release, released) = oneshot::channel::<()>();
        let (entered_tx, entered) = oneshot::channel::<()>();
        let first = {
            let c = c.clone();
            tokio::spawn(async move {
                c.with_session_mutation(async {
                    let _ = entered_tx.send(());
                    let _ = released.await;
                })
                .await
            })
        };
        entered.await.unwrap();
        assert!(c.session_mutation.try_lock().is_err());
        release.send(()).unwrap();
        first.await.unwrap();
        assert_eq!(c.with_session_mutation(async { 5 }).await, 5);
    }

    #[tokio::test(start_paused = true)]
    async fn url_sign_in_waits_for_consent_and_expires() {
        let c = Arc::new(Coordinator::new());
        let mut updates = Box::pin(c.watch_url_auth_action("i"));
        let request = {
            let c = c.clone();
            tokio::spawn(async move { c.request_url_authentication("i", action("e1")).await })
        };
        let published = updates.next().await.unwrap().unwrap();
        assert!(published.created_at.is_some() && published.expires_at.is_some());
        let accept = |id: &str| AcpRegistryAcceptUrlAuthInput {
            instance_id: "i".into(),
            elicitation_id: id.into(),
        };
        assert!(!c.accept_url_authentication(&accept("other")));
        assert!(c.accept_url_authentication(&accept("e1")));
        assert!(request.await.unwrap());
        assert_eq!(updates.next().await, Some(None));
        assert_eq!(c.url_auth_action("i"), None);

        // A newer request declines the older one.
        let older = {
            let c = c.clone();
            tokio::spawn(async move { c.request_url_authentication("i", action("old")).await })
        };
        assert_eq!(updates.next().await.unwrap().unwrap().elicitation_id, "old");
        let newer = {
            let c = c.clone();
            tokio::spawn(async move { c.request_url_authentication("i", action("new")).await })
        };
        assert!(!older.await.unwrap());
        // Ten minutes without an answer declines (paused clock, no real wait).
        assert!(!newer.await.unwrap());
        assert_eq!(c.url_auth_action("i"), None);
    }
}
