use goat2_contracts::codegen::{self, Files, Fixture};
use std::path::Path;

pub fn fixtures() -> Vec<Fixture> {
    codegen::load_fixtures().expect("load fixtures")
}

pub fn files(dir: &str) -> Files {
    let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let mut files = Files::new();
    codegen::read_tree(&base, &base.join(dir), &mut files).expect("read fixtures");
    files
}
