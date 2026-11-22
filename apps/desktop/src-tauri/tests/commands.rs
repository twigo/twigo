//! Every command of the IPC protocol has a handler, an entry in the app's
//! manifest and a permission in the main window's capability: one that
//! lacks either is refused by Tauri at runtime, with no error at build. And
//! each meets a panic as ARCHITECTURE 2.1 says.

use std::collections::BTreeSet;

fn between<'a>(text: &'a str, start: &str, end: &str) -> &'a str {
    let from = text.find(start).expect(start) + start.len();
    let to = from + text[from..].find(end).expect(end);
    &text[from..to]
}

fn quoted(text: &str) -> BTreeSet<String> {
    text.split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

#[test]
fn every_command_is_handled_listed_and_allowed() {
    let generated = include_str!("../../../../packages/protocol/src/generated.ts");
    let protocol: BTreeSet<String> = between(generated, "export type Commands = {", "\n};")
        .lines()
        .filter_map(|line| line.trim().split_once(':').map(|(name, _)| name.to_owned()))
        .collect();
    let manifest = quoted(between(include_str!("../build.rs"), ".commands(&[", "])"));
    let handled: BTreeSet<String> =
        between(include_str!("../src/main.rs"), "generate_handler![", "]")
            .split(',')
            .map(|name| name.trim().to_owned())
            .filter(|name| !name.is_empty())
            .collect();
    let allowed: BTreeSet<String> = quoted(include_str!("../capabilities/main.json"))
        .into_iter()
        .filter_map(|permission| {
            permission
                .strip_prefix("allow-")
                .map(|command| command.replace('-', "_"))
        })
        .collect();
    assert!(!protocol.is_empty());
    assert_eq!(manifest, protocol, "build.rs lists the protocol's commands");
    assert_eq!(handled, protocol, "main.rs handles the protocol's commands");
    assert_eq!(allowed, protocol, "capabilities/main.json allows them");
}

#[test]
fn every_command_meets_a_panic_through_the_fatal_path_or_contained() {
    let main = include_str!("../src/main.rs");
    assert!(
        main.contains(".invoke_handler(fatal.guarded_handler(tauri::generate_handler!["),
        "the invoke handler runs guarded"
    );
    let unguarded: Vec<&str> = main
        .split("#[tauri::command]\n")
        .skip(1)
        .filter(|command| command.starts_with("async fn "))
        .filter(|command| !between(command, "{", "\n}\n").contains("contained("))
        .map(|command| between(command, "async fn ", "("))
        .collect();
    assert!(main.contains("#[tauri::command]\nasync fn "));
    assert!(
        unguarded.is_empty(),
        "async commands not through contained(): {unguarded:?}"
    );
}
