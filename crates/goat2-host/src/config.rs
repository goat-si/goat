//! Launch contract with lane G (owner 2026-11-28).
//!
//! Env: `GOAT2_DATA_DIR` (default `~/.goat2`), `GOAT2_HOST_PORT` (0 = pick a free port),
//! `GOAT2_HOST_TOKEN` (UI token; when absent one is generated and written to `host.json` with
//! mode 0600, for manual runs). `--data-dir` / `--port` are aliases for manual runs only. A
//! relative data dir is made absolute against the host's working directory.
//! `GOAT2_ENGINE=fake` runs the scripted fake engine (UI work without Codex).
//! `GOAT2_CODEX_BIN` is the Codex program the driver starts (absolute path, e.g. a fake codex
//! app-server for parity runs); unset = `codex` on the host's PATH. The engine process
//! inherits the host's environment except host identity and the UI token.
//! `GOAT2_CLAUDE_BIN` is the Claude Code program the Claude driver starts (absolute path);
//! unset = `claude` on the host's PATH.

use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineChoice {
    Codex,
    Fake,
}

#[derive(Debug, Clone)]
pub struct HostConfig {
    pub data_dir: PathBuf,
    pub port: u16,
    /// Token from the environment; `None` = generate and write to `host.json`.
    pub ui_token: Option<String>,
    pub engine: EngineChoice,
    /// `GOAT2_CODEX_BIN`: the Codex program; `None` = `codex` on PATH.
    pub codex_bin: Option<PathBuf>,
    /// `GOAT2_CLAUDE_BIN`: the Claude Code program; `None` = `claude` on PATH.
    pub claude_bin: Option<PathBuf>,
    /// Exit when stdin closes (the parent died). Off for tests.
    pub exit_on_stdin_close: bool,
}

impl HostConfig {
    pub fn from_env_and_args(args: impl IntoIterator<Item = String>) -> Result<Self, String> {
        let mut data_dir = std::env::var_os("GOAT2_DATA_DIR").map(PathBuf::from);
        let mut port = match std::env::var("GOAT2_HOST_PORT") {
            Ok(p) => Some(
                p.parse::<u16>()
                    .map_err(|e| format!("GOAT2_HOST_PORT: {e}"))?,
            ),
            Err(_) => None,
        };
        let ui_token = std::env::var("GOAT2_HOST_TOKEN")
            .ok()
            .filter(|t| !t.is_empty());
        let engine = match std::env::var("GOAT2_ENGINE").as_deref() {
            Ok("fake") => EngineChoice::Fake,
            Ok("codex") | Err(_) => EngineChoice::Codex,
            Ok(other) => return Err(format!("GOAT2_ENGINE: unknown engine {other}")),
        };
        let codex_bin = std::env::var_os("GOAT2_CODEX_BIN")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let claude_bin = std::env::var_os("GOAT2_CLAUDE_BIN")
            .filter(|v| !v.is_empty())
            .map(PathBuf::from);
        let mut args = args.into_iter();
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--data-dir" => {
                    data_dir = Some(args.next().ok_or("--data-dir needs a value")?.into())
                }
                "--port" => {
                    port = Some(
                        args.next()
                            .ok_or("--port needs a value")?
                            .parse()
                            .map_err(|e| format!("--port: {e}"))?,
                    )
                }
                other => return Err(format!("unknown argument {other}")),
            }
        }
        let data_dir = match data_dir {
            Some(d) => d,
            None => home_dir()
                .ok_or("no HOME for the default data dir")?
                .join(".goat2"),
        };
        // Absolute, so the attachment paths named to an engine resolve from any thread cwd.
        let data_dir =
            std::path::absolute(&data_dir).map_err(|e| format!("data dir {data_dir:?}: {e}"))?;
        Ok(Self {
            data_dir,
            port: port.unwrap_or(0),
            ui_token,
            engine,
            codex_bin,
            claude_bin,
            exit_on_stdin_close: true,
        })
    }
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_relative_data_dir_becomes_absolute() {
        let cfg = super::HostConfig::from_env_and_args([
            "--data-dir".to_string(),
            "rel/goat2-data".to_string(),
        ])
        .unwrap();
        assert!(cfg.data_dir.is_absolute(), "{:?}", cfg.data_dir);
        assert_eq!(
            cfg.data_dir,
            std::env::current_dir().unwrap().join("rel/goat2-data")
        );
    }
}
