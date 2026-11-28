//! Helpers for bounded text fields and streaming offsets.

/// Cut `s` to at most `max_chars` Unicode scalar values.
pub fn clamp_chars(s: &str, max_chars: usize) -> String {
    match s.char_indices().nth(max_chars) {
        Some((byte_index, _)) => s[..byte_index].to_owned(),
        None => s.to_owned(),
    }
}

/// Cut `s` to at most `max_bytes` UTF-8 bytes without splitting a character.
pub fn clamp_bytes(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_owned();
    }
    let mut end = max_bytes;
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

/// Length in UTF-16 code units, the unit of `TextAppend.offset` (JavaScript `string.length`).
pub fn utf16_len(s: &str) -> u64 {
    s.encode_utf16().count() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clamp_chars_counts_scalars() {
        assert_eq!(clamp_chars("가나다라", 2), "가나");
        assert_eq!(clamp_chars("ab", 5), "ab");
    }

    #[test]
    fn clamp_bytes_keeps_char_boundaries() {
        assert_eq!(clamp_bytes("가나", 4), "가");
        assert_eq!(clamp_bytes("abc", 3), "abc");
    }

    #[test]
    fn utf16_len_matches_javascript_length() {
        assert_eq!(utf16_len("a가😀"), 4);
    }
}
