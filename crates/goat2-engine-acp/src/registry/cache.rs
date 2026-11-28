//! v1 `registryIndexCache.ts:42-253`, `AcpRegistrySupport.ts:71-85,509-511,594-707`.
use super::super::contracts::AcpRegistryOperationErrorReason as Reason;
use super::super::install::RegistryError;
use super::{Index, MAX_REGISTRY_BYTES, REGISTRY_URL, decode, index_too_large, valid_https_url};
use async_trait::async_trait;
use futures::StreamExt;
use std::{
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;

#[async_trait]
pub trait RegistryFetch: Send + Sync {
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, String>;
}
/// Real HTTPS transport with v1's 1 MiB streamed limit and its two 30-second timeouts: one for
/// the request, one more for reading the body (AcpRegistrySupport.ts:653-690, round 7 part 6b.5).
pub struct HttpsFetch {
    client: reqwest::Client,
}
const FETCH_TIMEOUT: Duration = Duration::from_secs(30);
impl HttpsFetch {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            client: reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::custom(|a| {
                    if a.url().scheme() == "https"
                        && a.url().username().is_empty()
                        && a.url().password().is_none()
                        && a.previous().len() < 10
                    {
                        a.follow()
                    } else {
                        a.stop()
                    }
                }))
                .build()
                .map_err(|e| e.to_string())?,
        })
    }
}
#[async_trait]
impl RegistryFetch for HttpsFetch {
    /// v1 `AcpRegistrySupport.ts:647-708` messages.
    async fn fetch(&self, url: &str) -> Result<Vec<u8>, String> {
        if !valid_https_url(url) {
            return Err("ACP Registry index URL must use HTTPS.".into());
        }
        let fetch_failed = |e: reqwest::Error| {
            if e.is_timeout() {
                "Timed out fetching ACP Registry index.".to_owned()
            } else {
                format!("Could not fetch ACP Registry index from {url}.")
            }
        };
        let response = tokio::time::timeout(FETCH_TIMEOUT, self.client.get(url).send())
            .await
            .map_err(|_| "Timed out fetching ACP Registry index.".to_owned())?
            .map_err(fetch_failed)?;
        // Only a 2xx final response is the index; a redirect the policy stopped is not
        // (v1 `filterStatusOk`, AcpRegistrySupport.ts:647-708).
        if !response.status().is_success() {
            return Err(format!("Could not fetch ACP Registry index from {url}."));
        }
        let read = async {
            let mut body = Vec::new();
            let mut stream = response.bytes_stream();
            while let Some(chunk) = stream.next().await {
                let chunk = chunk.map_err(|e| {
                    if e.is_timeout() {
                        "Timed out reading ACP Registry response body.".to_owned()
                    } else {
                        "Could not read ACP Registry response body.".to_owned()
                    }
                })?;
                if body.len() + chunk.len() > MAX_REGISTRY_BYTES {
                    return Err(index_too_large());
                }
                body.extend_from_slice(&chunk);
            }
            Ok(body)
        };
        tokio::time::timeout(FETCH_TIMEOUT, read)
            .await
            .map_err(|_| "Timed out reading ACP Registry response body.".to_owned())?
    }
}
#[derive(Default)]
struct State {
    index: Option<Index>,
    fetched: Option<u64>,
    failed: Option<u64>,
    error: Option<String>,
    fetch_rev: u64,
    attempt_rev: u64,
    generation: u64,
}
pub struct RegistryIndexCache<F> {
    fetcher: F,
    url: String,
    path: PathBuf,
    state: Mutex<State>,
    permit: Mutex<()>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn recent(stamp: Option<u64>, age: u64, t: u64) -> bool {
    stamp.is_some_and(|s| t >= s && t - s < age)
}
static NEXT_TMP: AtomicU64 = AtomicU64::new(0);
impl<F: RegistryFetch> RegistryIndexCache<F> {
    pub fn new(fetcher: F, data_dir: PathBuf, url: Option<String>) -> Self {
        Self {
            fetcher,
            url: url.unwrap_or_else(|| REGISTRY_URL.into()),
            path: data_dir.join("acp-registry/registry.json"),
            state: Mutex::new(State::default()),
            permit: Mutex::new(()),
        }
    }
    /// The cached index, read with the size limit applied while reading: at most
    /// MAX_REGISTRY_BYTES + 1 bytes are read, so [decode] rejects an oversized file without the
    /// whole file in memory (final review finding 22).
    async fn disk(&self) -> Option<Index> {
        use tokio::io::AsyncReadExt;
        let file = tokio::fs::File::open(&self.path).await.ok()?;
        let mut bytes = Vec::new();
        file.take(MAX_REGISTRY_BYTES as u64 + 1)
            .read_to_end(&mut bytes)
            .await
            .ok()?;
        decode(&bytes).ok()
    }
    /// Write the cache file atomically, on the blocking pool and outside the state lock (round 7
    /// part 6b.3; v1 registryIndexCache.ts:116-128 never holds its Ref across file I/O).
    async fn write(&self, bytes: Vec<u8>) {
        let path = self.path.clone();
        let _ = tokio::task::spawn_blocking(move || write_file(&path, &bytes)).await;
    }
    /// Load a cold disk cache without claiming it is fresh.
    pub async fn load(&self) -> Result<Index, String> {
        if let Some(i) = self.state.lock().await.index.clone() {
            return Ok(i);
        }
        if let Some(i) = self.disk().await {
            let mut s = self.state.lock().await;
            return Ok(s.index.get_or_insert(i).clone());
        }
        self.refresh(None, None).await.map(|r| r.0)
    }
    pub async fn invalidate(&self) {
        let mut s = self.state.lock().await;
        s.fetched = None;
        s.failed = None;
        s.error = None;
        s.generation += 1;
    }
    /// With no max age, always attempt a fetch; with an age, coalesce concurrent refreshes.
    pub async fn refresh(
        &self,
        max_age_ms: Option<u64>,
        backoff_ms: Option<u64>,
    ) -> Result<(Index, bool), String> {
        // v1 `recentRegistry` (registryIndexCache.ts:176-205) answers a fresh index, or a failure
        // still backing off, before waiting for a fetch in progress (round 7 part 6b.4).
        {
            let s = self.state.lock().await;
            let t = now();
            if let Some(i) = &s.index {
                if max_age_ms.is_some_and(|age| recent(s.fetched, age, t))
                    || backoff_ms.is_some_and(|age| recent(s.failed, age, t))
                {
                    return Ok((i.clone(), false));
                }
            } else if backoff_ms.is_some_and(|age| recent(s.failed, age, t))
                && let Some(e) = &s.error
            {
                return Err(e.clone());
            }
        }
        let (fetch_rev, attempt_rev) = {
            let s = self.state.lock().await;
            (s.fetch_rev, s.attempt_rev)
        };
        let _permit = self.permit.lock().await;
        let generation = {
            let s = self.state.lock().await;
            let t = now();
            if let Some(i) = &s.index {
                if max_age_ms.is_some_and(|age| recent(s.fetched, age, t))
                    || s.fetch_rev != fetch_rev
                    || (backoff_ms.is_some() && s.attempt_rev != attempt_rev)
                    || backoff_ms.is_some_and(|age| recent(s.failed, age, t))
                {
                    return Ok((i.clone(), false));
                }
            } else if backoff_ms.is_some()
                && (s.attempt_rev != attempt_rev
                    || backoff_ms.is_some_and(|age| recent(s.failed, age, t)))
                && let Some(e) = &s.error
            {
                return Err(e.clone());
            }
            s.generation
        };
        let result = if !valid_https_url(&self.url) {
            Err("ACP Registry index URL must use HTTPS.".into())
        } else {
            match self.fetcher.fetch(&self.url).await {
                Ok(bytes) => decode(&bytes).map(|i| (i, bytes)),
                Err(e) => Err(e),
            }
        };
        // File I/O happens before the state lock is taken (round 7 part 6b.3).
        let disk_fallback = match &result {
            Ok((_, bytes)) => {
                self.write(bytes.clone()).await;
                None
            }
            Err(_) if self.state.lock().await.index.is_none() => self.disk().await,
            Err(_) => None,
        };
        let mut s = self.state.lock().await;
        let t = now();
        match result {
            Ok((i, _)) => {
                let changed = s.index.as_ref().is_some_and(|old| old != &i);
                s.index = Some(i.clone());
                if s.generation == generation {
                    s.fetched = Some(t);
                    s.failed = None;
                    s.error = None;
                    s.fetch_rev += 1;
                    s.attempt_rev += 1;
                }
                Ok((i, changed))
            }
            Err(e) => {
                let fallback = s.index.clone().or(disk_fallback);
                if s.index.is_none() {
                    s.index = fallback.clone()
                }
                if s.generation == generation {
                    s.fetched = None;
                    s.failed = Some(t);
                    s.error = Some(e.clone());
                    s.attempt_rev += 1;
                }
                fallback.map(|i| (i, false)).ok_or(e)
            }
        }
    }
}
/// Default search freshness from v1 `AcpRegistrySupport.ts:82-85`.
pub const SEARCH_MAX_AGE_MS: u64 = 300_000;

fn write_file(path: &std::path::Path, bytes: &[u8]) {
    let Some(parent) = path.parent() else {
        return;
    };
    if std::fs::create_dir_all(parent).is_err() {
        return;
    }
    let tmp = parent.join(format!(
        "registry.json.{}-{}.tmp",
        std::process::id(),
        NEXT_TMP.fetch_add(1, Ordering::Relaxed)
    ));
    if std::fs::write(&tmp, bytes).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
    let _ = std::fs::remove_file(tmp);
}
pub type SharedRegistryCache<F> = Arc<RegistryIndexCache<F>>;
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Fake(AtomicUsize);
    #[async_trait]
    impl RegistryFetch for Fake {
        async fn fetch(&self, _: &str) -> Result<Vec<u8>, String> {
            if self.0.fetch_add(1, Ordering::SeqCst) == 0 {
                Ok(br#"{"version":"1","agents":[]}"#.to_vec())
            } else {
                Err("offline".into())
            }
        }
    }
    #[tokio::test]
    async fn freshness_invalidation_and_disk_fallback() {
        let dir = tempfile::tempdir().unwrap();
        let c = RegistryIndexCache::new(Fake(AtomicUsize::new(0)), dir.path().into(), None);
        assert!(c.load().await.is_ok());
        assert!(c.refresh(Some(SEARCH_MAX_AGE_MS), None).await.is_ok());
        assert_eq!(c.fetcher.0.load(Ordering::SeqCst), 1);
        c.invalidate().await;
        assert!(
            c.refresh(Some(SEARCH_MAX_AGE_MS), Some(10000))
                .await
                .is_ok()
        );
        assert_eq!(c.fetcher.0.load(Ordering::SeqCst), 2);
        let cold = RegistryIndexCache::new(Fake(AtomicUsize::new(1)), dir.path().into(), None);
        assert!(cold.load().await.is_ok());
        assert!(cold.refresh(None, None).await.is_ok());
    }

    /// A fetcher whose second fetch waits for `release` after announcing `started`.
    struct Gated {
        calls: AtomicUsize,
        started: tokio::sync::Notify,
        release: tokio::sync::Notify,
    }
    #[async_trait]
    impl RegistryFetch for Gated {
        async fn fetch(&self, _: &str) -> Result<Vec<u8>, String> {
            if self.calls.fetch_add(1, Ordering::SeqCst) > 0 {
                self.started.notify_one();
                self.release.notified().await;
            }
            Ok(br#"{"version":"1","agents":[]}"#.to_vec())
        }
    }

    /// v1 `recentRegistry` (registryIndexCache.ts:176-205) checks freshness before the fetch
    /// semaphore: a search with a fresh index does not wait behind a running fetch (round 7 part
    /// 6b.4). The 5 s limit only bounds a hang.
    #[tokio::test]
    async fn a_fresh_search_does_not_wait_for_a_running_fetch() {
        let dir = tempfile::tempdir().unwrap();
        let c = Arc::new(RegistryIndexCache::new(
            Gated {
                calls: AtomicUsize::new(0),
                started: tokio::sync::Notify::new(),
                release: tokio::sync::Notify::new(),
            },
            dir.path().into(),
            None,
        ));
        c.refresh(None, None).await.unwrap();
        let running = {
            let c = Arc::clone(&c);
            tokio::spawn(async move { c.refresh(None, None).await })
        };
        c.fetcher.started.notified().await;
        let fresh = tokio::time::timeout(
            Duration::from_secs(5),
            c.refresh(Some(SEARCH_MAX_AGE_MS), None),
        )
        .await
        .expect("the fresh search waited for the running fetch");
        assert!(fresh.is_ok());
        c.fetcher.release.notify_one();
        assert!(running.await.unwrap().is_ok());
    }

    /// The cached index is read with the 1 MiB limit applied while reading: a cache file that
    /// keeps growing is abandoned after MAX_REGISTRY_BYTES + 1 bytes (final review finding 22).
    /// A FIFO stands in for the file; the writer only fails when the reader stops early.
    #[cfg(unix)]
    #[tokio::test]
    async fn oversized_disk_cache_is_not_read_past_the_limit() {
        use std::io::Write;
        use std::os::unix::ffi::OsStrExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("acp-registry/registry.json");
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).unwrap();
        // SAFETY: c_path is a valid NUL-terminated path for the duration of the call.
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0);
        let writer_path = path.clone();
        let writer = std::thread::spawn(move || {
            let mut fifo = std::fs::OpenOptions::new()
                .write(true)
                .open(writer_path)
                .unwrap();
            fifo.write_all(&vec![b' '; 4 * MAX_REGISTRY_BYTES])
        });
        let c = RegistryIndexCache::new(Fake(AtomicUsize::new(0)), dir.path().into(), None);
        // The oversized cache is ignored and the index is fetched instead.
        assert!(c.load().await.is_ok());
        assert_eq!(c.fetcher.0.load(Ordering::SeqCst), 1);
        let written = writer.join().unwrap();
        assert_eq!(
            written.map_err(|e| e.kind()),
            Err(std::io::ErrorKind::BrokenPipe),
            "the cache reader consumed the whole oversized file"
        );
    }
}

/// v1 `registryResolveRefresh.ts:12-52`: refresh only on download failure and retry
/// only when the selected agent's launch identity changed.
pub async fn resolve_with_refresh<F, T, R, Fut>(
    cache: &RegistryIndexCache<F>,
    settings: &super::RegistrySettings,
    allow_install: bool,
    target: Option<&str>,
    mut resolve: R,
) -> Result<T, RegistryError>
where
    F: RegistryFetch,
    R: FnMut(Option<Index>) -> Fut,
    Fut: std::future::Future<Output = Result<T, RegistryError>>,
{
    if matches!(settings.source, super::Source::Local) || !allow_install {
        return resolve(None).await;
    }
    let original = cache
        .load()
        .await
        .map_err(|e| RegistryError::new(Reason::RegistryUnavailable, e))?;
    match resolve(Some(original.clone())).await {
        Err(error) if error.reason == Reason::DownloadFailed => {
            let latest = match cache.refresh(None, None).await {
                Ok((i, _)) => i,
                Err(_) => return Err(error),
            };
            let identity = |index: &Index| {
                index
                    .agents
                    .iter()
                    .find(|a| a.id == settings.agent_id.trim())
                    .and_then(|a| {
                        super::resolve_distribution(a, &settings.distribution, target)
                            .map(|d| super::launch_identity(Some(&a.version), &d, None))
                    })
            };
            if identity(&latest) == identity(&original) {
                return Err(error);
            }
            resolve(Some(latest)).await
        }
        result => result,
    }
}

#[cfg(test)]
mod retry_tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};
    struct Changing(AtomicUsize);
    #[async_trait]
    impl RegistryFetch for Changing {
        async fn fetch(&self, _: &str) -> Result<Vec<u8>, String> {
            let n = self.0.fetch_add(1, Ordering::SeqCst) + 1;
            Ok(format!(r#"{{"version":"1","agents":[{{"id":"a","name":"A","version":"{n}","description":"","distribution":{{"npx":{{"package":"a@1.0.0"}}}}}}]}}"#).into_bytes())
        }
    }
    #[tokio::test]
    async fn retry_only_changed_launch_identity() {
        let dir = tempfile::tempdir().unwrap();
        let c = RegistryIndexCache::new(Changing(AtomicUsize::new(0)), dir.path().into(), None);
        let settings = super::super::RegistrySettings {
            agent_id: "a".into(),
            ..Default::default()
        };
        let calls = AtomicUsize::new(0);
        let result = resolve_with_refresh(&c, &settings, true, None, |i| {
            let n = calls.fetch_add(1, Ordering::SeqCst);
            async move {
                assert!(i.is_some());
                if n == 0 {
                    Err(RegistryError::new(Reason::DownloadFailed, "bad"))
                } else {
                    Ok(())
                }
            }
        })
        .await;
        assert!(result.is_ok());
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }
}
