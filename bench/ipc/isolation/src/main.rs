use std::collections::HashMap;

use tauri::utils::config::{Csp, CspDirectiveSources};

fn main() {
    let mut context = tauri::generate_context!();

    // Tauri serves the isolation frame from a scheme it names anew on every build and adds it to `default-src` only, so `frame-src` must list it here.
    let tauri::Pattern::Isolation { schema, .. } = context.pattern() else {
        unreachable!("tauri-build requires the isolation feature for an isolation config");
    };
    let frame_source = format!("{schema}:");
    let security = &mut context.config_mut().app.security;
    let mut csp: HashMap<String, CspDirectiveSources> = security
        .csp
        .take()
        .expect("tauri.conf.json sets a CSP")
        .into();
    csp.entry("frame-src".to_owned())
        .or_default()
        .push(frame_source);
    security.csp = Some(Csp::DirectiveMap(csp));

    twigo_bench_ipc::run(context);
}
