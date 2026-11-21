use std::path::Path;

fn current(file: &str, fresh: &str) {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/src")
        .join(file);
    if std::env::var_os("TWIGO_UPDATE_TYPESCRIPT").is_some() {
        std::fs::write(&path, fresh).expect("write the generated module");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == fresh,
        "{} is stale: run TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript",
        path.display()
    );
}

#[test]
fn the_generated_module_is_current() {
    current("generated.ts", &twigo_ipc::typescript());
}

#[test]
fn the_table_of_error_kinds_is_current() {
    current("errorKinds.ts", &twigo_ipc::error_kinds());
}
