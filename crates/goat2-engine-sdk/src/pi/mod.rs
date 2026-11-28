//! Pieces of the Pi RPC driver.

mod dialog;
mod events;
mod extension;
mod probe;
mod session;

pub use session::{PiFactory, PiProfile};

/// Validate and normalize Pi launch arguments before passing them to the CLI.
///
/// Port of v1 `provider-pi/src/server/mcpInjection.ts:49-205`. Unlike v1's
/// string setting, GOAT 2 already supplies tokenized arguments.
pub fn resolve_launch_args(args: &[String], display_name: &str) -> Result<Vec<String>, String> {
    const RESERVED: &[&str] = &[
        "--continue",
        "-c",
        "--export",
        "--fork",
        "--help",
        "-h",
        "--list-models",
        "--mode",
        "--no-session",
        "--print",
        "-p",
        "--resume",
        "-r",
        "--session",
        "--session-id",
        "--version",
        "-v",
    ];
    const VALUES: &[&str] = &[
        "--api-key",
        "--append-system-prompt",
        "--exclude-tools",
        "-xt",
        "--extension",
        "-e",
        "--model",
        "--models",
        "--name",
        "-n",
        "--prompt-template",
        "--provider",
        "--session-dir",
        "--skill",
        "--system-prompt",
        "--theme",
        "--thinking",
        "--tools",
        "-t",
        "--tui-mode",
        "--use-theme",
    ];
    const FLAGS: &[&str] = &[
        "--approve",
        "-a",
        "--no-approve",
        "-na",
        "--no-builtin-tools",
        "-nbt",
        "--no-context-files",
        "-nc",
        "--no-extensions",
        "-ne",
        "--no-prompt-templates",
        "-np",
        "--no-skills",
        "-ns",
        "--no-themes",
        "--no-tools",
        "-nt",
        "--offline",
        "--verbose",
    ];
    let mut normalized = Vec::new();
    for arg in args {
        if let Some((option, value)) = arg.split_once('=')
            && VALUES.contains(&option)
        {
            normalized.extend([option.to_owned(), value.to_owned()]);
        } else {
            normalized.push(arg.clone());
        }
    }
    let (mut index, mut provider, mut model) = (0, false, false);
    while index < normalized.len() {
        let arg = &normalized[index];
        if let Some(reserved) = RESERVED.iter().find(|reserved| {
            arg == **reserved
                || (reserved.starts_with("--")
                    && arg
                        .strip_prefix(**reserved)
                        .is_some_and(|s| s.starts_with('=')))
        }) {
            return Err(format!(
                "{display_name} launch argument '{reserved}' is controlled by GOAT and cannot be overridden."
            ));
        }
        if arg == "--" {
            return Err(format!(
                "{display_name} launch arguments cannot include positional prompts."
            ));
        }
        if VALUES.contains(&arg.as_str()) {
            if index + 1 == normalized.len() {
                return Err(format!(
                    "{display_name} launch argument '{arg}' requires a value."
                ));
            }
            provider |= arg == "--provider";
            model |= arg == "--model";
            index += 2;
            continue;
        }
        if FLAGS.contains(&arg.as_str()) || (arg.starts_with("--") && arg.contains('=')) {
            index += 1;
            continue;
        }
        if arg.starts_with("--") {
            index += 1;
            if normalized
                .get(index)
                .is_some_and(|next| !next.starts_with('-') && !next.starts_with('@'))
            {
                index += 1;
            }
            continue;
        }
        if arg.starts_with('-') {
            return Err(format!(
                "{display_name} launch argument '{arg}' is not supported by GOAT."
            ));
        }
        return Err(format!(
            "{display_name} launch arguments cannot include positional prompt '{arg}'."
        ));
    }
    if provider && !model {
        return Err(format!(
            "{display_name} launch argument '--provider' requires '--model'."
        ));
    }
    Ok(normalized)
}

#[cfg(test)]
mod tests {
    use super::resolve_launch_args;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_owned()).collect()
    }

    #[test]
    fn normalizes_known_options_but_preserves_extension_equals() {
        assert_eq!(
            resolve_launch_args(&args(&["--provider=x", "--model=a/b", "--custom=v"]), "Pi")
                .unwrap(),
            args(&["--provider", "x", "--model", "a/b", "--custom=v"])
        );
    }

    #[test]
    fn rejects_reserved_positionals_and_incomplete_provider() {
        for input in [
            &["--session=x"][..],
            &["--mode", "rpc"],
            &["--"],
            &["prompt"],
            &["--provider", "x"],
            &["--model"],
        ] {
            assert!(
                resolve_launch_args(&args(input), "Pi").is_err(),
                "{input:?}"
            );
        }
    }

    #[test]
    fn extension_argument_may_have_a_value() {
        assert_eq!(
            resolve_launch_args(&args(&["--custom", "value", "--verbose"]), "OmO").unwrap(),
            args(&["--custom", "value", "--verbose"])
        );
    }
}
