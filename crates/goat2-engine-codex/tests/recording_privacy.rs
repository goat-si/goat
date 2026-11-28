//! Recordings are safe to publish: the redactor is fail-closed, the scan catches seeded secrets,
//! committed fixtures pass the scan on this machine, and every fixture was reviewed (REVIEW.md).

mod support;

use std::path::Path;

use goat2_engine_codex::transcript::{Entry, Redactor, Transcript, privacy_scan};
use serde_json::{Value, json};
use support::fake::fixture;

fn raw(entries: Vec<Value>) -> Transcript {
    support::fake::transcript("seeded", entries)
}

#[test]
fn seeded_secrets_do_not_survive_redaction() {
    let home = "/Users/someone";
    let secrets = [
        "/Users/someone/private/notes.txt",
        "someone@example.com",
        "sk-proj-abcdefghijklmnopqrstuvwxyz012345",
        "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdef",
    ];
    let t = raw(vec![
        json!({"type": "expect_outbound", "frame": {"id": 1, "method": "turn/start", "params": {"threadId": "t", "input": []}}}),
        json!({"type": "emit_inbound", "frame": {"id": 1, "result": {"turn": {"id": "u", "brandNewField": secrets[0]}}}}),
        json!({"type": "emit_inbound", "frame": {"method": "item/completed", "params": {
            "threadId": "t", "turnId": "u", "completedAtMs": 1,
            "item": {"type": "commandExecution", "id": "exec-1", "command": "ls", "commandActions": [], "cwd": secrets[0],
                     "status": "completed", "aggregatedOutput": format!("{} {} {}", secrets[1], secrets[2], secrets[3])}}}}),
        json!({"type": "emit_inbound", "frame": {"method": "item/completed", "params": {
            "threadId": "t", "turnId": "u", "completedAtMs": 1,
            "item": {"type": "mcpToolCall", "id": "mcp-1", "server": "s", "tool": "t", "arguments": {"k": secrets[2]},
                     "status": "completed", "result": {"content": [{"type": "text", "text": secrets[3]}]}}}}}),
        json!({"type": "emit_inbound", "frame": {"method": "account/updated", "params": {"email": secrets[1]}}}),
    ]);
    let redacted = Redactor::new().redact(&t).unwrap();
    let text = serde_json::to_string(&redacted).unwrap();
    for secret in secrets {
        assert!(!text.contains(secret), "{secret} survived: {text}");
    }
    assert!(
        privacy_scan(&text, Path::new(home), "someone").is_empty(),
        "{text}"
    );
    // account/updated is not in the driver subset and is dropped whole.
    assert!(!text.contains("account/updated"));
}

#[test]
fn a_non_id_in_an_id_field_aborts() {
    let t = raw(vec![
        json!({"type": "emit_inbound", "frame": {"method": "turn/started", "params": {
        "threadId": "t", "turn": {"id": "a-sixty-character-token-0123456789abcdef0123456789abcdef!!!"}}}}),
    ]);
    assert!(Redactor::new().redact(&t).is_err());
}

#[test]
fn a_secret_in_an_allowed_field_is_caught_by_the_scan() {
    let text = json!({"text": "my key is sk-proj-abcdefghijklmnopqrstuvwxyz012345"}).to_string();
    assert!(!privacy_scan(&text, Path::new("/Users/x"), "x").is_empty());
    let text = json!({"text": "mail me at a.person@example.org"}).to_string();
    assert!(!privacy_scan(&text, Path::new("/Users/x"), "x").is_empty());
    // Ordinary words and ids are not findings.
    let text = json!({"text": "the disk-image task-runner", "id": "msg_057fd8fb6fce587d016b0acd14306c87d0b7fed39e5abe932b",
        "itemId": "exec-e21688e4-81b3-4bc3-8b6e-342cd3f1bd0d", "threadId": "01a22232-ada4-7c81-9bb6-b71d391de842"}).to_string();
    assert!(
        privacy_scan(&text, Path::new("/Users/x"), "x").is_empty(),
        "{text}"
    );
}

#[test]
fn committed_fixtures_pass_the_scan_on_this_machine() {
    let home = std::env::var("HOME").unwrap_or_default();
    let user = std::env::var("USER").unwrap_or_default();
    for dir in ["codex-0.167.0", "synthetic"] {
        let Ok(entries) = std::fs::read_dir(fixture(dir)) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            let text = std::fs::read_to_string(&path).unwrap();
            let findings = privacy_scan(&text, Path::new(&home), &user);
            assert!(findings.is_empty(), "{}: {findings:?}", path.display());
        }
    }
}

#[test]
fn every_recording_is_listed_in_the_review() {
    let dir = fixture("codex-0.167.0");
    let review = std::fs::read_to_string(dir.join("REVIEW.md")).expect("REVIEW.md");
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let path = entry.path();
        if path.extension().is_none_or(|e| e != "json") {
            continue;
        }
        let digest = sha256_hex(&std::fs::read(&path).unwrap());
        let name = path.file_name().unwrap().to_string_lossy();
        assert!(
            review.contains(&format!("| {name} | {digest} |")),
            "{name} (sha256 {digest}) is not reviewed in REVIEW.md"
        );
    }
}

#[test]
fn redacted_outbound_values_become_wildcards() {
    let t = raw(vec![
        json!({"type": "expect_outbound", "frame": {"id": 1, "method": "thread/start", "params": {
        "cwd": "/Users/someone/project", "developerInstructions": "secret plans"}}}),
    ]);
    let redacted = Redactor::new().redact(&t).unwrap();
    let Entry::ExpectOutbound {
        frame, wildcards, ..
    } = &redacted.entries[0]
    else {
        panic!()
    };
    assert_eq!(frame["params"]["cwd"], "/redacted/0");
    assert!(wildcards.contains(&"/params/cwd".to_string()));
    assert!(wildcards.contains(&"/params/developerInstructions".to_string()));
}

/// Minimal SHA-256 so the test needs no extra crate.
fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];
    let mut message = data.to_vec();
    let bit_len = (data.len() as u64) * 8;
    message.push(0x80);
    while message.len() % 64 != 56 {
        message.push(0);
    }
    message.extend_from_slice(&bit_len.to_be_bytes());
    for chunk in message.chunks(64) {
        let mut w = [0u32; 64];
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[4 * i],
                chunk[4 * i + 1],
                chunk[4 * i + 2],
                chunk[4 * i + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }
        let mut v = h;
        for i in 0..64 {
            let s1 = v[4].rotate_right(6) ^ v[4].rotate_right(11) ^ v[4].rotate_right(25);
            let ch = (v[4] & v[5]) ^ (!v[4] & v[6]);
            let t1 = v[7]
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = v[0].rotate_right(2) ^ v[0].rotate_right(13) ^ v[0].rotate_right(22);
            let maj = (v[0] & v[1]) ^ (v[0] & v[2]) ^ (v[1] & v[2]);
            let t2 = s0.wrapping_add(maj);
            v = [
                t1.wrapping_add(t2),
                v[0],
                v[1],
                v[2],
                v[3].wrapping_add(t1),
                v[4],
                v[5],
                v[6],
            ];
        }
        for (a, b) in h.iter_mut().zip(v) {
            *a = a.wrapping_add(b);
        }
    }
    h.iter().map(|x| format!("{x:08x}")).collect()
}
