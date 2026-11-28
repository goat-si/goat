//! The ACP registry catalog, from v1 `AcpRegistrySupport.ts` at 916b5ccc1b2: `AcpRegistryCatalog`
//! (`:410-441`), its options and directories (`:443-466,509-533`), prepared-binary reservations
//! (`:548-581`), `findAgent`/`compatibleDistribution` (`:1446-1476`), `search` (`:1478-1529`),
//! `prepare` (`:1531-1555`), `inspect` (`:1557-1710`), `resolve` (`:1712-1866`, with
//! `registryResolveRefresh.ts`), `prepareRuntimeSpawn` (`registryRuntimeTemp.ts:124-146`) and
//! `uninstallManagedBinary` (`:1867-1957`).
//!
//! [AcpRegistryCatalog::launch] ties these together for the host's engine factory: settings in,
//! a [RegistryAgentFlavor] with the resolved [LaunchCommand] out. The catalog has no host
//! dependency; the caller supplies directories, transports, platform and environment.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use serde::Serialize;

use super::RegistryAgentFlavor;
use super::command_path::{self, Environment};
use super::contracts::{
    AcpRegistryDistribution, AcpRegistryManagedBinaryUninstallInput,
    AcpRegistryManagedBinaryUninstallResult, AcpRegistryOperationErrorReason as Reason,
    AcpRegistryPrepareInput, AcpRegistryPrepareResult, AcpRegistrySearchInput,
    AcpRegistrySearchResult, True,
};
use super::environment::session_environment;
use super::index::cache::{
    RegistryFetch, RegistryIndexCache, SEARCH_MAX_AGE_MS, resolve_with_refresh,
};
use super::index::{Agent, Index, ResolvedDistribution, launch_identity, resolve_distribution};
use super::install::{
    ArchiveDownload, Installer, OrRegistry, PREPARED_BINARY_RESERVATION, PackageKind,
    RegistryError, bounded_agent_id,
};
use super::package::package_manager_for;
use super::runtime_temp::{RegistryRuntimeTemp, RuntimeTempLease};
use super::settings::{DistributionPreference, RegistrySettings, Source};
use crate::flavor::LaunchCommand;

/// v1 `AcpRegistryCatalogOptions` (`AcpRegistrySupport.ts:461-466`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatalogOptions {
    /// v1 `providerStatusCacheDir`; the index cache and package receipts live in `acp-registry/`.
    pub cache_dir: PathBuf,
    /// Managed installs: `<tools_dir>/<agent>/<version>/<platform|npm|python>`.
    pub tools_dir: PathBuf,
    pub registry_url: Option<String>,
    /// Per-run temp root for agents that need one (Antigravity).
    pub runtime_temp_dir: Option<PathBuf>,
}

impl CatalogOptions {
    /// v1 `layerFromHost` (`AcpRegistrySupport.ts:446-459`) and `config.ts:149-157` relative to a
    /// caller-supplied data directory: `caches`, `tools`, `userdata/antigravity-tmp/acp-registry`.
    pub fn under(data_dir: &Path) -> Self {
        Self {
            cache_dir: data_dir.join("caches"),
            tools_dir: data_dir.join("tools"),
            registry_url: None,
            runtime_temp_dir: Some(
                data_dir
                    .join("userdata")
                    .join("antigravity-tmp")
                    .join("acp-registry"),
            ),
        }
    }
}

/// The platform, architecture and environment v1 reads from `HostProcess`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostContext {
    pub platform: String,
    pub architecture: String,
    pub environment: Environment,
}

impl HostContext {
    pub fn current() -> Self {
        Self {
            platform: command_path::host_platform().into(),
            architecture: command_path::host_architecture().into(),
            environment: command_path::host_environment(),
        }
    }
}

/// How a resolved agent launches (v1 `AcpRegistryDistribution | "local"`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LaunchKind {
    Binary,
    Npx,
    Uvx,
    Local,
}
impl From<AcpRegistryDistribution> for LaunchKind {
    fn from(kind: AcpRegistryDistribution) -> Self {
        match kind {
            AcpRegistryDistribution::Binary => Self::Binary,
            AcpRegistryDistribution::Npx => Self::Npx,
            AcpRegistryDistribution::Uvx => Self::Uvx,
        }
    }
}

/// v1 `AcpRegistryInspection` (`AcpRegistrySupport.ts:375-408`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "status",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum Inspection {
    Unconfigured,
    NotFound {
        agent_id: String,
    },
    Unsupported {
        agent_id: String,
        version: String,
    },
    MissingRunner {
        #[serde(skip_serializing_if = "Option::is_none")]
        agent_id: Option<String>,
        version: Option<String>,
        distribution: LaunchKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        runner: Option<String>,
    },
    Unprepared {
        agent_id: String,
        version: String,
        distribution: LaunchKind,
    },
    Ready {
        agent_id: String,
        version: Option<String>,
        distribution: LaunchKind,
        #[serde(skip_serializing_if = "Option::is_none")]
        launch_identity: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        documentation_url: Option<String>,
    },
}

/// v1 `AcpSpawnInput` as the catalog fills it (no shell).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpawnSpec {
    pub command: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
    /// The whole environment of the agent process.
    pub env: Environment,
}

/// v1 `ResolvedAcpRegistryAgent`.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedAgent {
    pub agent: Option<Agent>,
    pub distribution: LaunchKind,
    pub spawn: SpawnSpec,
}

/// v1 `resolve` options.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolveOptions {
    /// False for probes: never download or install, only use what was prepared.
    pub allow_install: bool,
    /// The environment the agent runs with, when it differs from the lookup environment.
    pub spawn_environment: Option<Environment>,
}
impl Default for ResolveOptions {
    fn default() -> Self {
        Self {
            allow_install: true,
            spawn_environment: None,
        }
    }
}

/// A resolved agent ready to start, plus the temp directory it owns while it runs.
#[derive(Debug)]
pub struct RegistryLaunch {
    pub flavor: RegistryAgentFlavor,
    pub resolved: ResolvedAgent,
    pub runtime_temp: Option<RuntimeTempLease>,
}

/// The catalog service (v1 `makeAcpRegistryCatalog`).
pub struct AcpRegistryCatalog<F: RegistryFetch> {
    installer: Installer,
    cache: RegistryIndexCache<F>,
    // Long installs must only block operations on the same agent.
    install_permits: std::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
    prepared_binaries: std::sync::Mutex<HashMap<String, tokio::time::Instant>>,
    runtime_temp: Option<RegistryRuntimeTemp>,
}

fn lock<T>(m: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn unavailable(detail: String) -> RegistryError {
    RegistryError::new(Reason::RegistryUnavailable, detail)
}

/// Turn a spawn into the driver's launch: the environment as changes against `base`.
pub fn launch_command(spawn: &SpawnSpec, base: &Environment) -> LaunchCommand {
    let mut command = LaunchCommand::new(spawn.command.clone(), spawn.args.clone());
    command.env = spawn
        .env
        .iter()
        .filter(|(k, v)| base.get(*k) != Some(*v))
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();
    command.env_remove = base
        .keys()
        .filter(|k| !spawn.env.contains_key(*k))
        .cloned()
        .collect();
    command
}

impl<F: RegistryFetch> AcpRegistryCatalog<F> {
    pub fn new(
        options: CatalogOptions,
        fetcher: F,
        download: Arc<dyn ArchiveDownload>,
        host: HostContext,
    ) -> Self {
        let runtime_temp = options
            .runtime_temp_dir
            .map(|root| RegistryRuntimeTemp::new(root, &host.platform));
        Self {
            cache: RegistryIndexCache::new(
                fetcher,
                options.cache_dir.clone(),
                options.registry_url,
            ),
            installer: Installer {
                cache_dir: options.cache_dir,
                tools_dir: options.tools_dir,
                platform: host.platform,
                architecture: host.architecture,
                host_environment: host.environment,
                download,
            },
            install_permits: Default::default(),
            prepared_binaries: Default::default(),
            runtime_temp,
        }
    }

    pub fn installer(&self) -> &Installer {
        &self.installer
    }

    fn permit(&self, agent_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        lock(&self.install_permits)
            .entry(agent_id.to_owned())
            .or_default()
            .clone()
    }

    /// v1 `AcpRegistrySupport.ts:548-557`.
    fn reserve_prepared_binary(&self, agent_id: &str) {
        let now = tokio::time::Instant::now();
        let mut reservations = lock(&self.prepared_binaries);
        reservations.retain(|_, expires| *expires > now);
        reservations.insert(agent_id.to_owned(), now + PREPARED_BINARY_RESERVATION);
    }
    #[cfg(test)]
    pub(crate) fn reserve_for_test(&self, agent_id: &str) {
        self.reserve_prepared_binary(agent_id);
    }
    /// v1 `AcpRegistrySupport.ts:559-565`.
    fn consume_prepared_binary_reservation(&self, agent_id: &str) {
        lock(&self.prepared_binaries).remove(agent_id);
    }
    /// v1 `AcpRegistrySupport.ts:567-581`.
    fn has_prepared_binary_reservation(&self, agent_id: &str) -> bool {
        let now = tokio::time::Instant::now();
        let mut reservations = lock(&self.prepared_binaries);
        match reservations.get(agent_id) {
            Some(expires) if *expires > now => true,
            Some(_) => {
                reservations.remove(agent_id);
                false
            }
            None => false,
        }
    }

    async fn load_registry(&self) -> Result<Index, RegistryError> {
        self.cache.load().await.map_err(unavailable)
    }

    /// v1 `AcpRegistrySupport.ts:1446-1458`.
    fn find_agent(index: &Index, agent_id: &str) -> Result<Agent, RegistryError> {
        let id = agent_id.trim();
        index
            .agents
            .iter()
            .find(|a| a.id == id)
            .cloned()
            .ok_or_else(|| {
                RegistryError::new(
                    Reason::AgentNotFound,
                    format!("ACP Registry does not contain agent '{id}'."),
                )
            })
    }

    /// v1 `AcpRegistrySupport.ts:1460-1476`.
    fn compatible_distribution(
        &self,
        agent: &Agent,
        preference: DistributionPreference,
    ) -> Result<ResolvedDistribution, RegistryError> {
        let target = self.installer.platform_target();
        resolve_distribution(agent, &preference, target).ok_or_else(|| {
            let which = match preference {
                DistributionPreference::Auto => "compatible",
                other => other.as_str(),
            };
            RegistryError::new(
                if target.is_none() {
                    Reason::UnsupportedPlatform
                } else {
                    Reason::UnsupportedDistribution
                },
                format!(
                    "ACP Registry agent {} has no {which} distribution for {}-{}.",
                    agent.id, self.installer.platform, self.installer.architecture
                ),
            )
        })
    }

    /// v1 `AcpRegistrySupport.ts:1478-1529`: a recent index (five minutes), compatible agents only.
    pub async fn search(
        &self,
        input: &AcpRegistrySearchInput,
    ) -> Result<AcpRegistrySearchResult, RegistryError> {
        let (index, _) = self
            .cache
            .refresh(Some(SEARCH_MAX_AGE_MS), None)
            .await
            .map_err(unavailable)?;
        let host = &self.installer.host_environment;
        let agents = super::index::search(
            &index,
            &input.query,
            input.limit(),
            self.installer.platform_target(),
            |manager| self.installer.resolve_executable(manager, host).is_some(),
        )
        .map_err(unavailable)?;
        Ok(AcpRegistrySearchResult { agents })
    }

    /// v1 `AcpRegistrySupport.ts:1531-1555`: always the latest index; installs the auto
    /// distribution. A prepared binary is reserved for 30 seconds against uninstall.
    pub async fn prepare(
        &self,
        input: &AcpRegistryPrepareInput,
    ) -> Result<AcpRegistryPrepareResult, RegistryError> {
        let (index, _) = self.cache.refresh(None, None).await.map_err(unavailable)?;
        let agent = Self::find_agent(&index, &input.agent_id)?;
        let distribution = self.compatible_distribution(&agent, DistributionPreference::Auto)?;
        let permit = self.permit(&agent.id);
        let _held = permit.lock().await;
        match (
            &distribution.binary_target,
            PackageKind::from_distribution(distribution.kind),
        ) {
            (Some(target), _) => {
                self.installer.install_binary(&agent, target).await?;
                self.reserve_prepared_binary(&agent.id);
            }
            (None, Some(kind)) => {
                let spec = distribution.package_name.as_deref().unwrap_or_default();
                self.installer
                    .ensure_global_package(&agent, kind, spec, &self.installer.host_environment)
                    .await?;
            }
            (None, None) => {}
        }
        Ok(AcpRegistryPrepareResult {
            agent_id: agent.id,
            version: agent.version,
            distribution: distribution.kind,
            prepared: True,
        })
    }

    /// v1 `registryIndexCache.ts:214-227`: whether the index changed.
    pub async fn refresh_index(
        &self,
        max_age: Option<Duration>,
        failure_backoff: Option<Duration>,
    ) -> Result<bool, RegistryError> {
        let ms = |d: Duration| d.as_millis().min(u64::MAX as u128) as u64;
        self.cache
            .refresh(max_age.map(ms), failure_backoff.map(ms))
            .await
            .map(|(_, changed)| changed)
            .map_err(unavailable)
    }

    /// v1 `registryIndexCache.ts:229-237`.
    pub async fn invalidate_index(&self) {
        self.cache.invalidate().await;
    }

    /// v1 `AcpRegistrySupport.ts:1557-1566`.
    fn validate_local_executable(&self, command: &Path) -> Result<(), RegistryError> {
        let is_batch = regex::Regex::new(r"(?i)\.(?:cmd|bat)$")
            .expect("static regex")
            .is_match(&command.to_string_lossy());
        if self.installer.platform == "win32" && is_batch {
            return Err(RegistryError::new(
                Reason::RunnerUnavailable,
                "Local ACP commands launch without a shell. For a Windows batch wrapper, configure the underlying executable (for example node.exe) and pass the script path as an argument.",
            ));
        }
        Ok(())
    }

    /// v1 `AcpRegistrySupport.ts:1568-1710`: whether these settings can launch now, without
    /// installing anything.
    pub async fn inspect(
        &self,
        settings: &RegistrySettings,
        environment: Option<&Environment>,
    ) -> Result<Inspection, RegistryError> {
        let env = environment.unwrap_or(&self.installer.host_environment);
        if settings.source == Source::Local {
            let command = settings.command_path.trim();
            if command.is_empty() {
                return Ok(Inspection::Unconfigured);
            }
            let Some(executable) = self.installer.resolve_executable(command, env) else {
                return Ok(Inspection::MissingRunner {
                    agent_id: None,
                    version: None,
                    distribution: LaunchKind::Local,
                    runner: None,
                });
            };
            self.validate_local_executable(&executable)?;
            return Ok(Inspection::Ready {
                agent_id: command.into(),
                version: None,
                distribution: LaunchKind::Local,
                launch_identity: None,
                documentation_url: None,
            });
        }
        let agent_id = settings.agent_id.trim();
        if agent_id.is_empty() {
            return Ok(Inspection::Unconfigured);
        }
        let index = self.load_registry().await?;
        let Some(agent) = index.agents.iter().find(|a| a.id == agent_id).cloned() else {
            return Ok(Inspection::NotFound {
                agent_id: agent_id.into(),
            });
        };
        let documentation_url = agent.website.clone().or_else(|| agent.repository.clone());
        let Some(distribution) = resolve_distribution(
            &agent,
            &settings.distribution,
            self.installer.platform_target(),
        ) else {
            return Ok(Inspection::Unsupported {
                agent_id: agent_id.into(),
                version: agent.version,
            });
        };
        let command_override = settings.command_path.trim();
        let identity = launch_identity(
            (command_override.is_empty()).then_some(agent.version.as_str()),
            &distribution,
            Some(command_override),
        );
        let ready = |version: Option<String>| Inspection::Ready {
            agent_id: agent_id.into(),
            version,
            distribution: distribution.kind.into(),
            launch_identity: Some(identity.clone()),
            documentation_url: documentation_url.clone(),
        };
        if !command_override.is_empty() {
            return Ok(
                if self
                    .installer
                    .resolve_executable(command_override, env)
                    .is_some()
                {
                    ready(None)
                } else {
                    Inspection::MissingRunner {
                        agent_id: Some(agent_id.into()),
                        version: Some(agent.version.clone()),
                        distribution: distribution.kind.into(),
                        runner: Some(command_override.into()),
                    }
                },
            );
        }
        if let Some(target) = &distribution.binary_target {
            let permit = self.permit(&agent.id);
            let _held = permit.lock().await;
            let Some(paths) = self.installer.binary_paths(&agent, target) else {
                return Ok(Inspection::Unsupported {
                    agent_id: agent_id.into(),
                    version: agent.version,
                });
            };
            self.consume_prepared_binary_reservation(&agent.id);
            let exists = paths.executable_path.try_exists().unwrap_or(false);
            // Any prepared version keeps the agent ready; resolve installs the current one on demand.
            if !exists && !self.installer.has_installed_binary_version(&agent.id) {
                return Ok(Inspection::Unprepared {
                    agent_id: agent_id.into(),
                    version: agent.version,
                    distribution: LaunchKind::Binary,
                });
            }
            if exists {
                self.installer
                    .assert_executable_in_root(&paths.install_root, &paths.executable_path, false)
                    .or_registry(
                        Reason::InstallFailed,
                        format!("Could not validate cached ACP Registry agent {}.", agent.id),
                    )?;
            }
            return Ok(ready(Some(agent.version.clone())));
        }
        let kind = PackageKind::from_distribution(distribution.kind);
        let runner = package_manager_for(distribution.kind).unwrap_or_default();
        let Some(manager) = self.installer.resolve_executable(runner, env) else {
            return Ok(Inspection::MissingRunner {
                agent_id: Some(agent_id.into()),
                version: Some(agent.version.clone()),
                distribution: distribution.kind.into(),
                runner: Some(runner.into()),
            });
        };
        let unprepared = || Inspection::Unprepared {
            agent_id: agent_id.into(),
            version: agent.version.clone(),
            distribution: distribution.kind.into(),
        };
        let (Some(kind), Some(spec)) = (kind, distribution.package_name.as_deref()) else {
            return Ok(unprepared());
        };
        match self
            .installer
            .read_package_receipt(&agent, kind, spec, &manager.to_string_lossy())
            .await
        {
            None => Ok(unprepared()),
            Some(_) => Ok(ready(Some(agent.version.clone()))),
        }
    }

    /// v1 `AcpRegistrySupport.ts:1712-1859` (`resolveOnce`).
    async fn resolve_once(
        &self,
        settings: &RegistrySettings,
        cwd: &Path,
        environment: Option<&Environment>,
        options: &ResolveOptions,
        registry: Option<Index>,
    ) -> Result<ResolvedAgent, RegistryError> {
        let effective = environment.unwrap_or(&self.installer.host_environment);
        if settings.source == Source::Local {
            let executable = settings.command_path.trim();
            if executable.is_empty() {
                return Err(RegistryError::new(
                    Reason::AgentNotConfigured,
                    "Local ACP provider requires an executable.",
                ));
            }
            let Some(command) = self.installer.resolve_executable(executable, effective) else {
                return Err(RegistryError::new(
                    Reason::RunnerUnavailable,
                    "Local ACP executable is not available on this environment's PATH.",
                ));
            };
            self.validate_local_executable(&command)?;
            return Ok(ResolvedAgent {
                agent: None,
                distribution: LaunchKind::Local,
                spawn: SpawnSpec {
                    command: command_path::resolve_absolute_local_command(&command),
                    args: settings.command_args.clone(),
                    cwd: cwd.to_path_buf(),
                    env: options
                        .spawn_environment
                        .clone()
                        .unwrap_or_else(|| effective.clone()),
                },
            });
        }
        let agent_id = settings.agent_id.trim();
        if agent_id.is_empty() {
            return Err(RegistryError::new(
                Reason::AgentNotConfigured,
                "ACP Registry provider requires a registry agent ID.",
            ));
        }
        let registry = match registry {
            Some(index) => index,
            None => self.load_registry().await?,
        };
        let agent = Self::find_agent(&registry, agent_id)?;
        let distribution = self.compatible_distribution(&agent, settings.distribution)?;
        let not_prepared = || {
            RegistryError::new(
                Reason::RunnerUnavailable,
                format!(
                    "ACP Registry agent {} has not been prepared on this environment.",
                    agent.id
                ),
            )
        };
        let command_override = settings.command_path.trim();
        let mut command_bin_directory = None;
        let command = if !command_override.is_empty() {
            self.installer
                .resolve_executable(command_override, effective)
                .ok_or_else(|| {
                    RegistryError::new(
                        Reason::RunnerUnavailable,
                        format!(
                            "ACP Registry agent {} requires '{command_override}', but it is not available on this provider instance's PATH.",
                            agent.id
                        ),
                    )
                })?
        } else if let Some(kind) = PackageKind::from_distribution(distribution.kind) {
            let (Some(spec), Some(manager_name)) = (
                distribution.package_name.as_deref(),
                package_manager_for(distribution.kind),
            ) else {
                return Err(RegistryError::new(
                    Reason::RunnerUnavailable,
                    format!("ACP Registry agent {} has no package runner.", agent.id),
                ));
            };
            let permit = self.permit(&agent.id);
            let _held = permit.lock().await;
            let installed = if options.allow_install {
                self.installer
                    .ensure_global_package(&agent, kind, spec, effective)
                    .await?
            } else {
                let manager = self.installer.resolve_executable(manager_name, effective);
                let receipt = match manager {
                    None => None,
                    Some(manager) => {
                        self.installer
                            .read_package_receipt(&agent, kind, spec, &manager.to_string_lossy())
                            .await
                    }
                };
                receipt.ok_or_else(not_prepared)?
            };
            command_bin_directory = Some(PathBuf::from(&installed.bin_directory));
            PathBuf::from(installed.executable_path)
        } else {
            let target = distribution
                .binary_target
                .as_ref()
                .ok_or_else(not_prepared)?;
            let permit = self.permit(&agent.id);
            let _held = permit.lock().await;
            let command = if options.allow_install {
                self.installer.install_binary(&agent, target).await?
            } else {
                let paths = self
                    .installer
                    .binary_paths(&agent, target)
                    .filter(|p| p.executable_path.try_exists().unwrap_or(false))
                    .ok_or_else(not_prepared)?;
                self.installer
                    .assert_executable_in_root(&paths.install_root, &paths.executable_path, false)
                    .or_registry(
                        Reason::RunnerUnavailable,
                        format!(
                            "Could not read the prepared ACP Registry agent {}.",
                            agent.id
                        ),
                    )?;
                paths.executable_path
            };
            self.consume_prepared_binary_reservation(&agent.id);
            command
        };
        let mut env = options
            .spawn_environment
            .clone()
            .unwrap_or_else(|| effective.clone());
        env.extend(distribution.env.clone());
        if let Some(directory) = command_bin_directory {
            env = command_path::with_preferred_path(&env, &directory, &self.installer.platform);
        }
        Ok(ResolvedAgent {
            agent: Some(agent),
            distribution: distribution.kind.into(),
            spawn: SpawnSpec {
                command,
                args: distribution.args,
                cwd: cwd.to_path_buf(),
                env,
            },
        })
    }

    /// v1 `registryResolveRefresh.ts:13-52`: on a failed download, refresh the index once and
    /// retry only when the agent's launch identity changed.
    pub async fn resolve(
        &self,
        settings: &RegistrySettings,
        cwd: &Path,
        environment: Option<&Environment>,
        options: &ResolveOptions,
    ) -> Result<ResolvedAgent, RegistryError> {
        resolve_with_refresh(
            &self.cache,
            settings,
            options.allow_install,
            self.installer.platform_target(),
            |registry| self.resolve_once(settings, cwd, environment, options, registry),
        )
        .await
    }

    /// v1 `registryRuntimeTemp.ts:124-146`: Antigravity runs with its own temp directory.
    pub fn prepare_runtime_spawn(
        &self,
        resolved: &ResolvedAgent,
    ) -> Result<(SpawnSpec, Option<RuntimeTempLease>), RegistryError> {
        let is_antigravity = resolved
            .agent
            .as_ref()
            .is_some_and(|a| a.id == "antigravity-acp");
        let Some(temp) = self.runtime_temp.as_ref().filter(|_| is_antigravity) else {
            return Ok((resolved.spawn.clone(), None));
        };
        let (env, lease) = temp.acquire(&resolved.spawn.env).map_err(|_| {
            RegistryError::new(
                Reason::InstallFailed,
                "Could not create a temp directory for the ACP agent.",
            )
        })?;
        Ok((
            SpawnSpec {
                env,
                ..resolved.spawn.clone()
            },
            Some(lease),
        ))
    }

    /// v1 `AcpRegistrySupport.ts:1867-1957`. `configured` is every ACP registry instance's
    /// settings; an agent still referenced by one, or prepared in the last 30 seconds, is kept.
    pub async fn uninstall_managed_binary(
        &self,
        input: &AcpRegistryManagedBinaryUninstallInput,
        configured: &[RegistrySettings],
    ) -> Result<AcpRegistryManagedBinaryUninstallResult, RegistryError> {
        let permit = self.permit(&input.agent_id);
        let _held = permit.lock().await;
        if !bounded_agent_id(&input.agent_id) {
            return Err(RegistryError::new(
                Reason::InstallFailed,
                "ACP Registry managed binary uninstall received an invalid agent ID.",
            ));
        }
        let agent_id = input.agent_id.clone();
        let kept = || AcpRegistryManagedBinaryUninstallResult {
            agent_id: agent_id.clone(),
            removed: false,
        };
        let referenced = configured
            .iter()
            .any(|s| s.source != Source::Local && s.agent_id.trim() == agent_id);
        if referenced {
            self.consume_prepared_binary_reservation(&agent_id);
            return Ok(kept());
        }
        if self.has_prepared_binary_reservation(&agent_id) {
            return Ok(kept());
        }
        let removed = self.installer.remove_managed_binaries(&agent_id)?;
        Ok(AcpRegistryManagedBinaryUninstallResult { agent_id, removed })
    }

    /// v1 `acpRegistryManagedBinaryDirectories`.
    pub fn managed_binary_directories(&self) -> Vec<PathBuf> {
        self.installer.managed_binary_directories()
    }

    /// Resolve these settings into a launch for the shared ACP driver, as v1's registry adapter
    /// does (`adapter.ts:150-179,268-269,350-369`): the session environment (claude-acp's v2 flag),
    /// `resolve` with it as the spawn environment, then the runtime temp directory.
    pub async fn launch(
        &self,
        settings: &RegistrySettings,
        cwd: &Path,
        environment: Option<&Environment>,
        allow_install: bool,
    ) -> Result<RegistryLaunch, RegistryError> {
        let base = environment.unwrap_or(&self.installer.host_environment);
        let options = ResolveOptions {
            allow_install,
            spawn_environment: Some(session_environment(settings, base)),
        };
        let resolved = self.resolve(settings, cwd, Some(base), &options).await?;
        let (spawn, runtime_temp) = self.prepare_runtime_spawn(&resolved)?;
        let local = settings.source == Source::Local;
        let flavor = RegistryAgentFlavor {
            agent_id: if local {
                settings.command_path.trim().to_owned()
            } else {
                settings.agent_id.trim().to_owned()
            },
            command: launch_command(&spawn, &self.installer.host_environment),
            local,
        };
        Ok(RegistryLaunch {
            flavor,
            resolved: ResolvedAgent { spawn, ..resolved },
            runtime_temp,
        })
    }
}
