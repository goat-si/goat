//! `goat2-host`: started by GOAT 2's Electron main (lane G). See README.md.

use std::io::Read;

use goat2_host::config::HostConfig;

fn main() {
    #[cfg(unix)]
    // SAFETY: setpgid(0, 0) puts this process in its own group so the shell can stop the whole
    // host tree with one signal; no memory is touched.
    unsafe {
        libc::setpgid(0, 0);
    }
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_env("GOAT2_LOG")
                .unwrap_or_else(|_| "info".into()),
        )
        .init();
    let cfg = match HostConfig::from_env_and_args(std::env::args().skip(1)) {
        Ok(cfg) => cfg,
        Err(err) => {
            eprintln!("goat2-host: {err}");
            std::process::exit(2);
        }
    };
    let exit_on_stdin_close = cfg.exit_on_stdin_close;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    runtime.block_on(async move {
        let running = match goat2_host::server::start(cfg).await {
            Ok(running) => running,
            Err(err) => {
                eprintln!("goat2-host: {err}");
                std::process::exit(1);
            }
        };
        println!(
            "{}",
            serde_json::to_string(&running.ready).expect("ready line")
        );
        let (stop_tx, mut stop_rx) = tokio::sync::mpsc::unbounded_channel::<&'static str>();
        if exit_on_stdin_close {
            let tx = stop_tx.clone();
            std::thread::spawn(move || {
                let mut buf = [0u8; 256];
                let mut stdin = std::io::stdin();
                while matches!(stdin.read(&mut buf), Ok(n) if n > 0) {}
                let _ = tx.send("stdin closed");
            });
        }
        {
            let tx = stop_tx.clone();
            tokio::spawn(async move {
                let _ = tokio::signal::ctrl_c().await;
                let _ = tx.send("interrupt");
            });
        }
        #[cfg(unix)]
        {
            let tx = stop_tx.clone();
            tokio::spawn(async move {
                if let Ok(mut term) =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                {
                    term.recv().await;
                    let _ = tx.send("terminate");
                }
            });
        }
        let why = stop_rx.recv().await.unwrap_or("stopped");
        tracing::info!(why, "shutting down");
        running.shutdown().await;
    });
}
