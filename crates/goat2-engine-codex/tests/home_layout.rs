//! Per-instance Codex homes (v1 CodexHomeLayout.ts), on temporary folders only.
#![cfg(unix)]

use std::fs;
use std::os::unix::fs::symlink;
use std::path::Path;

use goat2_engine_codex::home_layout::{HomeLayout, HomeLayoutError, resolve};

/// A fresh folder under the system temp dir, removed on drop (no tempfile dev-dependency).
struct TempDir(std::path::PathBuf);

impl TempDir {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn tempdir() -> TempDir {
    use std::sync::atomic::{AtomicU32, Ordering};
    static NEXT: AtomicU32 = AtomicU32::new(0);
    let dir = std::env::temp_dir().join(format!(
        "goat2-codex-homes-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    // Canonical, so symlink targets compare equal on macOS (/var -> /private/var).
    TempDir(dir.canonicalize().unwrap())
}

fn link_target(p: &Path) -> Option<std::path::PathBuf> {
    fs::symlink_metadata(p)
        .ok()
        .filter(|m| m.file_type().is_symlink())
        .and_then(|_| fs::read_link(p).ok())
}

fn overlay(root: &Path) -> HomeLayout {
    resolve(
        Some(&root.join("shared")),
        Some(&root.join("instance")),
        root,
    )
}

#[test]
fn the_default_instance_uses_the_shared_home_directly() {
    let dir = tempdir();
    let layout = resolve(None, None, dir.path());
    assert_eq!(
        layout,
        HomeLayout::Direct {
            shared: dir.path().join(".codex"),
            effective: None
        }
    );
    assert_eq!(layout.codex_home(), None);
    assert!(layout.launch_args().is_empty());
    layout.materialize().unwrap();
    assert!(
        !dir.path().join(".codex").exists(),
        "a direct layout creates nothing"
    );
    // A shared home named in settings is set as CODEX_HOME.
    let named = resolve(Some(&dir.path().join("h/../h2")), None, dir.path());
    assert_eq!(named.codex_home(), Some(dir.path().join("h2").as_path()));
    assert_eq!(
        named.continuation_key(),
        format!("codex:home:{}", dir.path().join("h2").display())
    );
}

#[test]
fn an_instance_overlay_shares_everything_but_the_account_files() {
    let dir = tempdir();
    let shared = dir.path().join("shared");
    fs::create_dir_all(shared.join("sessions")).unwrap();
    fs::create_dir_all(shared.join("rules")).unwrap();
    fs::create_dir_all(shared.join("log")).unwrap();
    fs::write(shared.join("config.toml"), "model = \"x\"").unwrap();
    fs::write(shared.join("auth.json"), "{\"person\": 1}").unwrap();
    fs::write(shared.join("models_cache.json"), "{}").unwrap();
    fs::write(shared.join(".DS_Store"), "").unwrap();
    let layout = overlay(dir.path());
    let instance = dir.path().join("instance");
    assert_eq!(layout.codex_home(), Some(instance.as_path()));
    assert!(!layout.materialize().unwrap().kept_local_thread_writer_locks);

    for name in [
        "config.toml",
        "sessions",
        "rules",
        "skills",
        "plugins",
        "thread-writer-locks",
    ] {
        assert_eq!(
            link_target(&instance.join(name)),
            Some(shared.join(name)),
            "{name}"
        );
    }
    // Known shared folders are created in the shared home.
    assert!(shared.join("skills").is_dir() && shared.join("archived_sessions").is_dir());
    for name in [
        "auth.json",
        "models_cache.json",
        "auth.lock",
        "log",
        ".DS_Store",
    ] {
        assert!(
            fs::symlink_metadata(instance.join(name)).is_err(),
            "{name} must not be shared"
        );
    }
    // The instance's own sign-in stays its own across setups (idempotent).
    fs::write(instance.join("auth.json"), "{\"second\": 2}").unwrap();
    layout.materialize().unwrap();
    assert_eq!(
        fs::read_to_string(instance.join("auth.json")).unwrap(),
        "{\"second\": 2}"
    );
    assert_eq!(
        fs::read_to_string(shared.join("auth.json")).unwrap(),
        "{\"person\": 1}"
    );
    // The continuation key is the shared home, so native threads resume under either instance.
    assert_eq!(
        layout.continuation_key(),
        resolve(Some(&shared), None, dir.path()).continuation_key()
    );
}

#[test]
fn stale_links_and_local_runtime_folders_are_repaired() {
    let dir = tempdir();
    let shared = dir.path().join("shared");
    let instance = dir.path().join("instance");
    fs::create_dir_all(&shared).unwrap();
    fs::write(shared.join("config.toml"), "").unwrap();
    fs::create_dir_all(&instance).unwrap();
    fs::create_dir_all(dir.path().join("elsewhere")).unwrap();
    symlink(dir.path().join("elsewhere"), instance.join("config.toml")).unwrap();
    fs::create_dir_all(instance.join("mcp-oauth-locks")).unwrap();
    fs::write(instance.join("mcp-oauth-locks/x"), "").unwrap();
    fs::create_dir_all(instance.join("thread-writer-locks")).unwrap();
    fs::write(instance.join("thread-writer-locks/.coordination.lock"), "").unwrap();
    // Private files that are symlinks are dropped (the account keeps its own).
    symlink(
        shared.join("models_cache.json"),
        instance.join("models_cache.json"),
    )
    .unwrap();
    symlink(shared.join("auth.lock"), instance.join("auth.lock")).unwrap();

    overlay(dir.path()).materialize().unwrap();
    assert_eq!(
        link_target(&instance.join("config.toml")),
        Some(shared.join("config.toml"))
    );
    assert_eq!(
        link_target(&instance.join("mcp-oauth-locks")),
        Some(shared.join("mcp-oauth-locks"))
    );
    assert_eq!(
        link_target(&instance.join("thread-writer-locks")),
        Some(shared.join("thread-writer-locks"))
    );
    assert!(fs::symlink_metadata(instance.join("models_cache.json")).is_err());
    assert!(fs::symlink_metadata(instance.join("auth.lock")).is_err());
}

#[test]
fn a_live_local_thread_lock_is_kept_until_a_later_setup() {
    let dir = tempdir();
    let instance = dir.path().join("instance");
    fs::create_dir_all(instance.join("thread-writer-locks")).unwrap();
    fs::write(instance.join("thread-writer-locks/t1.lock"), "").unwrap();
    let layout = overlay(dir.path());
    assert!(layout.materialize().unwrap().kept_local_thread_writer_locks);
    assert!(instance.join("thread-writer-locks/t1.lock").exists());
    fs::remove_file(instance.join("thread-writer-locks/t1.lock")).unwrap();
    assert!(!layout.materialize().unwrap().kept_local_thread_writer_locks);
    assert!(link_target(&instance.join("thread-writer-locks")).is_some());
}

#[test]
fn conflicts_fail_instead_of_overwriting() {
    // A real file where a shared entry belongs is never replaced.
    let dir = tempdir();
    fs::create_dir_all(dir.path().join("shared")).unwrap();
    fs::write(dir.path().join("shared/config.toml"), "").unwrap();
    fs::create_dir_all(dir.path().join("instance")).unwrap();
    fs::write(dir.path().join("instance/config.toml"), "mine").unwrap();
    assert!(matches!(
        overlay(dir.path()).materialize(),
        Err(HomeLayoutError::EntryConflict { entry, .. }) if entry == "config.toml"
    ));
    assert_eq!(
        fs::read_to_string(dir.path().join("instance/config.toml")).unwrap(),
        "mine"
    );

    // A shared auth.json would mix accounts.
    let dir = tempdir();
    fs::create_dir_all(dir.path().join("instance")).unwrap();
    symlink(
        dir.path().join("shared/auth.json"),
        dir.path().join("instance/auth.json"),
    )
    .unwrap();
    assert!(matches!(
        overlay(dir.path()).materialize(),
        Err(HomeLayoutError::PrivateEntrySymlink { .. })
    ));

    // The overlay cannot be the shared home itself.
    let dir = tempdir();
    let same = resolve(
        Some(&dir.path().join("h")),
        Some(&dir.path().join("h/./")),
        dir.path(),
    );
    assert!(matches!(
        same.materialize(),
        Err(HomeLayoutError::PathConflict { .. })
    ));
}

#[test]
fn an_overlay_points_bundled_plugins_at_its_own_tmp() {
    let dir = tempdir();
    let args: Vec<String> = overlay(dir.path())
        .launch_args()
        .into_iter()
        .map(|a| a.into_string().unwrap())
        .collect();
    let source = dir
        .path()
        .join("instance/.tmp/bundled-marketplaces/openai-bundled");
    assert_eq!(
        args,
        vec![
            "-c".to_string(),
            format!(
                "marketplaces.openai-bundled.source={}",
                serde_json::to_string(source.to_str().unwrap()).unwrap()
            )
        ]
    );
}

#[test]
fn layouts_and_their_errors_never_print_paths() {
    let dir = tempdir();
    let layout = overlay(dir.path());
    let shown = format!("{layout:?}");
    assert!(!shown.contains(dir.path().to_str().unwrap()), "{shown}");
    fs::create_dir_all(dir.path().join("shared")).unwrap();
    fs::write(dir.path().join("shared/config.toml"), "").unwrap();
    fs::create_dir_all(dir.path().join("instance")).unwrap();
    fs::write(dir.path().join("instance/config.toml"), "").unwrap();
    let error = layout.materialize().unwrap_err();
    for shown in [error.to_string(), format!("{error:?}")] {
        assert!(!shown.contains(dir.path().to_str().unwrap()), "{shown}");
        assert!(shown.contains("config.toml"), "{shown}");
    }
}
