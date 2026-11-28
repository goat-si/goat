//! Small shared helpers.

/// RFC 3339 UTC timestamp with milliseconds.
pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// A new random id with a readable prefix, such as `run_1f0c...`.
pub fn new_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::new_v4().simple())
}

/// 32 random bytes as lowercase hex, for bearer tokens.
pub fn new_token() -> String {
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A stable 128-bit hex digest of the parts (FNV-1a, two seeds). Used for ids derived from an
/// idempotency key, so a retry after a restart lands on the same record.
pub fn stable_id(parts: &[&str]) -> String {
    let mut out = String::with_capacity(32);
    for seed in [0xcbf2_9ce4_8422_2325u64, 0x8422_2325_cbf2_9ce4u64] {
        let mut h = seed;
        for part in parts {
            for b in part.bytes().chain(std::iter::once(0xff)) {
                h ^= u64::from(b);
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        }
        out.push_str(&format!("{h:016x}"));
    }
    out
}

/// Constant-time string comparison for tokens.
pub fn token_eq(a: &str, b: &str) -> bool {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}
