//! Every frame of every committed transcript validates against the pinned schema.

mod support;

use support::fake::fixture;
use support::schema::{SchemaBook, check_transcript};

#[test]
fn recorded_and_synthetic_frames_match_the_pinned_schema() {
    let mut book = SchemaBook::load();
    let mut totals = support::schema::Counts::default();
    let mut failures = Vec::new();
    let mut files = 0;
    for dir in ["codex-0.167.0", "synthetic"] {
        let Ok(entries) = std::fs::read_dir(fixture(dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            files += 1;
            let text = std::fs::read_to_string(&path).unwrap();
            let transcript =
                serde_json::from_str(&text).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
            let (f, counts) = check_transcript(&mut book, &transcript);
            failures.extend(f);
            totals.client_requests += counts.client_requests;
            totals.client_notifications += counts.client_notifications;
            totals.client_responses += counts.client_responses;
            totals.server_notifications += counts.server_notifications;
            totals.server_requests += counts.server_requests;
            totals.server_responses += counts.server_responses;
        }
    }
    assert!(
        files >= 5,
        "expected the five recordings, found {files} files"
    );
    assert!(
        failures.is_empty(),
        "schema failures:\n{}",
        failures.join("\n")
    );
    // Every frame kind was actually exercised.
    assert!(
        totals.client_requests > 0
            && totals.client_notifications > 0
            && totals.client_responses > 0
    );
    assert!(
        totals.server_notifications > 0
            && totals.server_requests > 0
            && totals.server_responses > 0
    );
}
