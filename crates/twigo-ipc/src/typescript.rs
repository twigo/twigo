use std::collections::BTreeMap;
use std::fmt::Write;

use ts_rs::{Config, TS, TypeVisitor};

use crate::command::{
    ClusterVersionGet, Command, ContextAuthWatch, ContextSignIn, ContextSignInCancel,
    ContextsWatch, ExecReviewGet, ExecTrust, KeyboardLayoutWatch, ListAck, ListSetWindow,
    ListSubscribe, ListUnsubscribe, NamespacesList, ResourcesList, ShellEnvironmentRetry,
    ShellEnvironmentWatch, SpaceOpen, SpacesList, StateLoad, StateSet, UrlOpen,
};

/// The TypeScript module of `packages/protocol`: every type the commands
/// reach, and the `Commands` table that types its invoke client.
pub fn typescript() -> String {
    let mut module = Module {
        cfg: Config::new().with_large_int("number"),
        declarations: BTreeMap::new(),
        commands: String::new(),
    };
    module.command::<SpacesList>();
    module.command::<ContextsWatch>();
    module.command::<SpaceOpen>();
    module.command::<ResourcesList>();
    module.command::<NamespacesList>();
    module.command::<ClusterVersionGet>();
    module.command::<ListSubscribe>();
    module.command::<ListSetWindow>();
    module.command::<ListAck>();
    module.command::<ListUnsubscribe>();
    module.command::<KeyboardLayoutWatch>();
    module.command::<StateLoad>();
    module.command::<StateSet>();
    module.command::<ShellEnvironmentWatch>();
    module.command::<ShellEnvironmentRetry>();
    module.command::<ContextAuthWatch>();
    module.command::<ContextSignIn>();
    module.command::<ContextSignInCancel>();
    module.command::<ExecReviewGet>();
    module.command::<ExecTrust>();
    module.command::<UrlOpen>();

    let mut out = String::from(
        "// Generated from crates/twigo-ipc: TWIGO_UPDATE_TYPESCRIPT=1 cargo test -p twigo-ipc --test typescript\n",
    );
    for declaration in module.declarations.values() {
        out.push('\n');
        out.push_str(declaration);
        out.push('\n');
    }
    out.push_str("\nexport type Commands = {\n");
    out.push_str(&module.commands);
    out.push_str("};\n");
    out
}

struct Module {
    cfg: Config,
    declarations: BTreeMap<String, String>,
    commands: String,
}

impl Module {
    fn command<C: Command>(&mut self) {
        self.visit::<C::Request>();
        self.visit::<C::Response>();
        self.visit::<C::Message>();
        let cfg = &self.cfg;
        writeln!(
            self.commands,
            "  {}: {{ request: {}; response: {}; message: {} }};",
            C::NAME,
            C::Request::name(cfg),
            C::Response::name(cfg),
            C::Message::name(cfg),
        )
        .expect("writing to a String cannot fail");
    }
}

impl TypeVisitor for Module {
    fn visit<T: TS + 'static + ?Sized>(&mut self) {
        if T::output_path().is_some() {
            let name = T::ident(&self.cfg);
            if self.declarations.contains_key(&name) {
                return;
            }
            let declaration = format!(
                "{}export {}",
                T::docs().unwrap_or_default(),
                T::decl(&self.cfg)
            );
            self.declarations.insert(name, declaration);
        }
        T::visit_dependencies(self);
        // A wrapper such as Vec<T> reaches T only as a generic.
        T::visit_generics(self);
    }
}
