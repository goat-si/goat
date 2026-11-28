use goat2_parity::refs::{Roots, check};
use std::{
    fs,
    path::PathBuf,
    sync::atomic::{AtomicUsize, Ordering},
};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    dir: PathBuf,
    roots: Roots,
}
impl Fixture {
    fn new() -> Self {
        let dir = std::env::temp_dir().join(format!(
            "parity-refs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(dir.join("root/a")).unwrap();
        fs::write(dir.join("root/a/f.rs"), "one\ntwo\n").unwrap();
        let root = dir.join("root");
        Self {
            dir,
            roots: Roots {
                v1: root.clone(),
                sdk_py: root.clone(),
                sdk_ts: root.clone(),
                design: root.clone(),
                goat2: root,
            },
        }
    }
    fn doc(&self, name: &str, text: &str) -> PathBuf {
        let p = self.dir.join(name);
        fs::write(&p, text).unwrap();
        p
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.dir);
    }
}
#[test]
fn refs_activation() {
    let f = Fixture::new();
    let good = f.doc("good.md", "`a/f.rs:1-2`\n");
    assert!(check(&f.roots, std::slice::from_ref(&good)).is_ok());
    for text in [
        "`a/f.rs:3`",
        "`f.rs:1`",
        "`a/f.rs:L12`",
        "plain",
        "`a/missing.rs:1`",
        "`../outside.rs:1`",
    ] {
        let p = f.doc("bad.md", text);
        assert!(check(&f.roots, &[p]).is_err(), "{text}");
    }
    let empty = f.doc("empty.md", "nothing");
    assert!(check(&f.roots, &[good, empty]).is_err());
    let mut roots = f.roots.clone();
    roots.sdk_py = f.dir.join("missing");
    let doc = f.doc("one.md", "`a/f.rs:1`");
    assert!(check(&roots, &[doc]).is_err());
}

#[test]
fn absolute_path_ref_fails() {
    let f = Fixture::new();
    let p = f.doc("absolute.md", "`/tmp/a/f.rs:1`");
    assert!(check(&f.roots, &[p]).is_err());
}
macro_rules! passing_root {
    ($name:ident, $field:ident, $prefix:literal) => {
        #[test]
        fn $name() {
            let mut f = Fixture::new();
            let distinct = f.dir.join(stringify!($field));
            fs::create_dir_all(distinct.join("only")).unwrap();
            fs::write(distinct.join("only/file.rs"), "line\n").unwrap();
            f.roots.$field = distinct;
            let doc = f.doc("case.md", concat!("`", $prefix, "only/file.rs:1`"));
            assert!(check(&f.roots, &[doc]).is_ok());
        }
    };
}
passing_root!(python_sdk_prefix_passes, sdk_py, "claude-agent-sdk-python/");
passing_root!(
    typescript_sdk_prefix_passes,
    sdk_ts,
    "@anthropic-ai/claude-agent-sdk@0.3.276/"
);
passing_root!(design_prefix_passes, design, "goat2-design/");
passing_root!(goat2_prefix_passes, goat2, "goat2/");
passing_root!(unprefixed_v1_passes, v1, "");
