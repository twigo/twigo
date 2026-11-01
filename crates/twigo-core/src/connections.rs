//! The clients of each context (ARCHITECTURE 3.2, 6.3): built when first
//! asked for, rebuilt for every actor at once when the context's fingerprint
//! or the login shell's proxy variables change.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use kube::Config;
use kube::config::{KubeConfigOptions, KubeconfigError};
use twigo_kube::client::{self, Clients, Options, ProxyEnv, ProxyError, proxy_for};
use twigo_kube::kubeconfig::{self, Fingerprint};

#[derive(Default)]
pub struct Connections {
    contexts: Mutex<HashMap<String, Arc<tokio::sync::Mutex<Option<Built>>>>>,
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
    pub async fn clients(
        &self,
        context: &kubeconfig::Context,
        env: &ProxyEnv,
    ) -> Result<Arc<Clients>, Error> {
        let slot = {
            let mut contexts = self.contexts.lock().expect("connections lock");
            Arc::clone(contexts.entry(context.name.clone()).or_default())
        };
        let mut built = slot.lock().await;
        if let Some(built) = &*built
            && built.fingerprint == context.fingerprint
            && built.env == *env
        {
            return Ok(Arc::clone(&built.clients));
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
                ..Options::default()
            },
        )?);
        *built = Some(Built {
            fingerprint: context.fingerprint,
            env: env.clone(),
            clients: Arc::clone(&clients),
        });
        Ok(clients)
    }

    /// Drops the clients of contexts no source lists any more.
    pub fn keep(&self, names: &HashSet<String>) {
        let mut contexts = self.contexts.lock().expect("connections lock");
        contexts.retain(|name, _| names.contains(name));
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
            // A slot being built has no connection yet.
            .filter_map(|(name, slot)| {
                let built = slot.try_lock().ok()?;
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
            .clients(find(&catalog, "kind-a"), &env)
            .await
            .unwrap();
        let b = connections
            .clients(find(&catalog, "kind-b"), &env)
            .await
            .unwrap();
        let again = connections
            .clients(find(&catalog, "kind-a"), &env)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&a, &again));

        ca(
            dir.path(),
            &rcgen::generate_simple_self_signed(["a".to_owned()]).unwrap(),
        );
        let catalog = load(dir.path());
        let rebuilt = connections
            .clients(find(&catalog, "kind-a"), &env)
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&a, &rebuilt), "the CA file changed");
        let same = connections
            .clients(find(&catalog, "kind-b"), &env)
            .await
            .unwrap();
        assert!(Arc::ptr_eq(&b, &same));

        let proxied = ProxyEnv::from_vars(|name| {
            (name == "HTTPS_PROXY").then(|| "http://proxy.example:3128".to_owned())
        });
        let through = connections
            .clients(find(&catalog, "kind-b"), &proxied)
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&b, &through), "the proxy variables changed");
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
            .clients(find(&catalog, "kind-b"), &env)
            .await
            .unwrap();

        connections.keep(&HashSet::from(["kind-a".to_owned()]));
        let again = connections
            .clients(find(&catalog, "kind-b"), &env)
            .await
            .unwrap();
        assert!(!Arc::ptr_eq(&b, &again));
    }
}
