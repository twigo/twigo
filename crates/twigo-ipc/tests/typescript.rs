use std::path::Path;

#[test]
fn the_generated_module_is_current() {
    let path =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/protocol/src/generated.ts");
    let fresh = twigo_ipc::typescript();
    if std::env::var_os("TWIGO_UPDATE_TYPESCRIPT").is_some() {
        std::fs::write(&path, &fresh).expect("write the generated module");
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == fresh,
        "{} is stale: run TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript",
        path.display()
    );
}
