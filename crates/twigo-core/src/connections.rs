//! The clients of each context (ARCHITECTURE 3.2, 6.3): built when first
//! asked for, rebuilt for every actor at once when the context's fingerprint
//! or the login shell's proxy variables change, which retires the
//! connections of the clients they replace.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use kube::Config;
use kube::config::{KubeConfigOptions, KubeconfigError};
use twigo_kube::client::{self, Clients, Options, ProxyEnv, ProxyError, proxy_for};
use twigo_kube::credentials::Provider;
use twigo_kube::kubeconfig::{self, Fingerprint};

#[derive(Default)]
pub struct Connections {
    /// Taken before the others, so a build stores its clients only while
    /// what they were built from is still current.
    latest: Mutex<Latest>,
    contexts: Mutex<HashMap<String, Arc<Slot>>>,
}

/// The last proxy variables and fingerprints followed.
#[derive(Default)]
struct Latest {
    env: Option<ProxyEnv>,
    fingerprints: Option<HashMap<String, Fingerprint>>,
}

impl Latest {
    fn current(&self, context: &kubeconfig::Context, env: &ProxyEnv) -> bool {
        self.env.as_ref().is_none_or(|latest| latest == env)
            && self
                .fingerprints
                .as_ref()
                .is_none_or(|latest| latest.get(&context.name) == Some(&context.fingerprint))
    }
}

/// A context's clients, which retiring reaches while new ones are built.
#[derive(Default)]
struct Slot {
    building: tokio::sync::Mutex<()>,
    built: Mutex<Option<Built>>,
}

impl Slot {
    fn current(&self, context: &kubeconfig::Context, env: &ProxyEnv) -> Option<Arc<Clients>> {
        let built = self.built.lock().expect("slot lock");
        let built = built.as_ref()?;
        (built.fingerprint == context.fingerprint && built.env == *env)
            .then(|| Arc::clone(&built.clients))
    }
}

struct Built {
    fingerprint: Fingerprint,
    env: ProxyEnv,
    clients: Arc<Clients>,
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error(transparent)]
    Kubeconfig(#[from] KubeconfigError),
    #[error(transparent)]
    Proxy(#[from] ProxyError),
    #[error(transparent)]
    Clients(#[from] client::Error),
}

impl Connections {
    /// `provider` is where the context's credential comes from, which its
    /// fingerprint covers.
    pub async fn clients(
        &self,
        context: &kubeconfig::Context,
        env: &ProxyEnv,
        provider: Option<Provider>,
    ) -> Result<Arc<Clients>, Error> {
        let slot = {
            let mut contexts = self.contexts.lock().expect("connections lock");
            Arc::clone(contexts.entry(context.name.clone()).or_default())
        };
        if let Some(clients) = slot.current(context, env) {
            return Ok(clients);
        }
        let _building = slot.building.lock().await;
        if let Some(clients) = slot.current(context, env) {
            return Ok(clients);
        }
        let options = KubeConfigOptions {
            context: Some(context.name.clone()),
            ..KubeConfigOptions::default()
        };
        let config = Config::from_custom_kubeconfig(context.entries.kubeconfig(), &options).await?;
        let proxy = proxy_for(&config.cluster_url, context.entries.proxy_url(), env)?;
        let clients = Arc::new(Clients::new(
            &config,
            Options {
                proxy,
                provider,
                ..Options::default()
            },
        )?);
        let latest = self.latest.lock().expect("latest lock");
        if !latest.current(context, env) {
            // Built from a context or proxy variables that changed meanwhile:
            // its watches re-open at once, over clients built from the new.
            drop(latest);
            clients.connections().retire();
            return Ok(clients);
        }
        let replaced = slot.built.lock().expect("slot lock").replace(Built {
            fingerprint: context.fingerprint,
            env: env.clone(),
            clients: Arc::clone(&clients),
        });
        drop(latest);
        if let Some(replaced) = replaced {
            // Its watches re-open over the new clients, which may reach
            // another server.
            replaced.clients.connections().retire();
        }
        Ok(clients)
    }

    /// Follows what the sources list now, by context and fingerprint:
    /// the clients of a context no source lists any more, or whose
    /// fingerprint changed, are dropped and their connections retired, so
    /// the watches over them re-open, over rebuilt clients if their
    /// context is still listed.
    pub fn keep(&self, listed: &HashMap<String, Fingerprint>) {
        let mut latest = self.latest.lock().expect("latest lock");
        latest.fingerprints = Some(listed.clone());
        let mut contexts = self.contexts.lock().expect("connections lock");
        let mut gone = Vec::new();
        contexts.retain(|name, slot| {
            let mut built = slot.built.lock().expect("slot lock");
            let current = listed.get(name);
            if built
                .as_ref()
                .is_some_and(|built| current != Some(&built.fingerprint))
            {
                gone.extend(built.take().map(|built| built.clients));
            }
            current.is_some()
        });
        drop(contexts);
        drop(latest);
        for clients in gone {
            clients.connections().retire();
        }
    }

    /// Drops the clients built with other proxy variables than `env`, the
    /// login shell's now, and retires their connections.
    pub fn follow_env(&self, env: &ProxyEnv) {
        let mut latest = self.latest.lock().expect("latest lock");
        latest.env = Some(env.clone());
        let contexts = self.contexts.lock().expect("connections lock");
        let mut gone = Vec::new();
        for slot in contexts.values() {
            let mut built = slot.built.lock().expect("slot lock");
            if built.as_ref().is_some_and(|built| built.env != *env) {
                gone.extend(built.take().map(|built| built.clients));
            }
        }
        drop(contexts);
        drop(latest);
        for clients in gone {
            clients.connections().retire();
        }
    }

    /// Retires the connections of every context, as on wake from sleep.
    pub fn retire(&self) {
        for (name, clients) in self.built() {
            clients.connections().retire();
            eprintln!("woke from sleep: retired the connections of {name}");
        }
    }

    /// Retires the connections of each context whose route moved, as after
    /// a network change.
    pub fn retire_moved(&self) {
        for (name, clients) in self.built() {
            if clients.connections().retire_moved() {
                eprintln!("the route to {name} moved: retired its connections");
            }
        }
    }

    fn built(&self) -> Vec<(String, Arc<Clients>)> {
        let contexts = self.contexts.lock().expect("connections lock");
        contexts
            .iter()
            .filter_map(|(name, slot)| {
                let built = slot.built.lock().expect("slot lock");
                Some((name.clone(), Arc::clone(&built.as_ref()?.clients)))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use std::path::Path;

    use twigo_kube::kubeconfig::Sources;

    use super::*;

    const KUBECONFIG: &str = "
clusters:
- name: a
  cluster: { server: 'https://a.example:6443', certificate-authority: ca.pem }
- name: b
  cluster: { server: 'https://b.example:6443' }
contexts:
- name: kind-a
  context: { cluster: a }
- name: kind-b
  context: { cluster: b }
";

    fn load(dir: &Path) -> kubeconfig::Catalog {
        Sources::explicit(dir.join("config")).load()
    }

    fn find<'a>(catalog: &'a kubeconfig::Catalog, name: &str) -> &'a kubeconfig::Context {
        catalog.contexts.iter().find(|c| c.name == name).unwrap()
    }

    fn ca(dir: &Path, cert: &rcgen::CertifiedKey<rcgen::KeyPair>) {
        std::fs::write(dir.join("ca.pem"), cert.cert.pem()).unwrap();
    }

    #[tokio::test]
    async fn clients_are_rebuilt_only_when_their_context_or_the_proxy_variables_change() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config"), KUBECONFIG).unwrap();
        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let connections = Connections::default();
        let env = ProxyEnv::default();

        let catalog = load(dir.path());
        let a = connections
            .clients(find(&catalog, "kind-a"), &env, None)
            .await
            .unwrap();
        let b = connections
            .clients(find(&catalog, "kind-b"), &env, None)
            .await
            .unwrap();
        let again = connections
            .clients(find(&catalog, "kind-a"), &env, None)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&a, &again));

        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let catalog = load(dir.path());
        let retired = a.connections().retired();
        let rebuilt = connections
            .clients(find(&catalog, "kind-a"), &env, None)
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&a, &rebuilt), "the CA file changed");
        assert!(
            retired.has_changed().unwrap(),
            "the replaced clients' watches re-open"
        );
        let same = connections
            .clients(find(&catalog, "kind-b"), &env, None)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&b, &same));

        let proxied = ProxyEnv::from_vars(|name| {
            (name == "HTTPS_PROXY").then(|| "http://proxy.example:3128".to_owned())
        });
        let through = connections
            .clients(find(&catalog, "kind-b"), &proxied, None)
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&b, &through), "the proxy variables changed");
    }

    #[tokio::test]
    async fn retiring_reaches_clients_while_new_ones_are_built() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config"), KUBECONFIG).unwrap();
        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let connections = Connections::default();
        let catalog = load(dir.path());
        let a = connections
            .clients(find(&catalog, "kind-a"), &ProxyEnv::default(), None)
            .await
            .unwrap();
        let retired = a.connections().retired();

        let slot = Arc::clone(&connections.contexts.lock().unwrap()["kind-a"]);
        let _building = slot.building.lock().await;
        connections.retire();
        assert!(retired.has_changed().unwrap());
    }

    #[tokio::test]
    async fn a_changed_context_or_proxy_retires_its_clients_at_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config"), KUBECONFIG).unwrap();
        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let connections = Connections::default();
        let env = ProxyEnv::default();
        let catalog = load(dir.path());
        let a = connections
            .clients(find(&catalog, "kind-a"), &env, None)
            .await
            .unwrap();
        let b = connections
            .clients(find(&catalog, "kind-b"), &env, None)
            .await
            .unwrap();
        let (a_retired, b_retired) = (a.connections().retired(), b.connections().retired());

        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let catalog = load(dir.path());
        let listed: HashMap<String, Fingerprint> = catalog
            .contexts
            .iter()
            .map(|context| (context.name.clone(), context.fingerprint))
            .collect();
        connections.keep(&listed);
        assert!(a_retired.has_changed().unwrap(), "its CA file changed");
        assert!(!b_retired.has_changed().unwrap(), "it did not change");
        connections.keep(&listed);
        connections.follow_env(&env);
        assert!(
            !b_retired.has_changed().unwrap(),
            "the same contexts and proxy retire nothing"
        );

        let proxied = ProxyEnv::from_vars(|name| {
            (name == "HTTPS_PROXY").then(|| "http://proxy.example:3128".to_owned())
        });
        connections.follow_env(&proxied);
        assert!(b_retired.has_changed().unwrap(), "the proxy changed");
    }

    #[tokio::test]
    async fn clients_built_from_what_changed_meanwhile_are_retired_at_once() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config"), KUBECONFIG).unwrap();
        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let connections = Connections::default();
        let env = ProxyEnv::default();
        let before = load(dir.path());
        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let after = load(dir.path());
        connections.keep(
            &after
                .contexts
                .iter()
                .map(|context| (context.name.clone(), context.fingerprint))
                .collect(),
        );

        let stale = connections
            .clients(find(&before, "kind-a"), &env, None)
            .await
            .unwrap();
        assert_eq!(
            *stale.connections().retired().borrow(),
            1,
            "retired at once"
        );
        let current = connections
            .clients(find(&after, "kind-a"), &env, None)
            .await
            .unwrap();
        assert_eq!(*current.connections().retired().borrow(), 0);
        let again = connections
            .clients(find(&after, "kind-a"), &env, None)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&current, &again), "the current ones are kept");
    }

    #[tokio::test]
    async fn a_context_no_source_lists_loses_its_clients() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("config"), KUBECONFIG).unwrap();
        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let connections = Connections::default();
        let env = ProxyEnv::default();
        let catalog = load(dir.path());
        let b = connections
            .clients(find(&catalog, "kind-b"), &env, None)
            .await
            .unwrap();

        let retired = b.connections().retired();
        let a = find(&catalog, "kind-a").fingerprint;
        connections.keep(&HashMap::from([("kind-a".to_owned(), a)]));
        assert!(
            retired.has_changed().unwrap(),
            "the watches over them re-open"
        );
        let again = connections
            .clients(find(&catalog, "kind-b"), &env, None)
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&b, &again));
    }
}
