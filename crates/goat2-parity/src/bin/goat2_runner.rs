fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if let Err(e) = goat2_parity::goat2_runner::drive::main_with_args(&args) {
        eprintln!("goat2-parity-goat2-runner: {e}");
        std::process::exit(1);
    }
}
