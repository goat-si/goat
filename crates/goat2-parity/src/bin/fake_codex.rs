use goat2_parity::fake_codex::Replay;
use std::{
    io::{self, BufRead, Write},
    path::PathBuf,
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let transcript = PathBuf::from(
        std::env::var_os("GOAT2_PARITY_FAKE_TRANSCRIPT")
            .ok_or("missing GOAT2_PARITY_FAKE_TRANSCRIPT")?,
    );
    let dir = PathBuf::from(
        std::env::var_os("GOAT2_PARITY_FAKE_DIR").ok_or("missing GOAT2_PARITY_FAKE_DIR")?,
    );
    let mut replay = Replay::open(&transcript, &dir)?;
    let mut stdout = io::stdout().lock();
    for line in io::stdin().lock().lines() {
        let frame = serde_json::from_str(&line?)?;
        for response in replay.handle(&frame)? {
            serde_json::to_writer(&mut stdout, &response)?;
            writeln!(stdout)?;
        }
        stdout.flush()?;
    }
    Ok(())
}
