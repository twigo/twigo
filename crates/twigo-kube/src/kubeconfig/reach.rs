//! Which contexts of a kubeconfig reach their clusters past the entries it
//! was written with, as a tool that writes entries of its own into another
//! program's kubeconfig leaves them: `aws eks update-kubeconfig` adds a
//! cluster, a user and a context, and with `--alias` replaces a context of
//! the same name.

use std::collections::{BTreeMap, BTreeSet};

use kube::config::{Kubeconfig, KubeconfigError};
use serde::Serialize;
use serde_json::Value;

/// The clusters and users a kubeconfig was written with, as parsed.
#[derive(Debug, Clone)]
pub struct Reach {
    clusters: BTreeMap<String, Value>,
    users: BTreeMap<String, Value>,
}

impl Reach {
    /// The entries of a kubeconfig's text, the first of a name where it
    /// repeats; refused where it does not parse.
    pub fn of(text: &str) -> Result<Self, KubeconfigError> {
        Ok(Self::held(&Kubeconfig::from_yaml(text)?))
    }

    fn held(config: &Kubeconfig) -> Self {
        Self {
            clusters: by_name(config.clusters.iter().map(|named| (&named.name, named))),
            users: by_name(config.auth_infos.iter().map(|named| (&named.name, named))),
        }
    }

    /// The contexts of `text` whose cluster, or the user they name, is not,
    /// by name and as parsed, one of these entries. A context these entries
    /// reach under another name or with another namespace goes where they go.
    pub fn past(&self, text: &str) -> Result<BTreeSet<String>, KubeconfigError> {
        let config = Kubeconfig::from_yaml(text)?;
        let now = Self::held(&config);
        let held =
            |ours: &BTreeMap<String, Value>, theirs: &BTreeMap<String, Value>, name: &str| {
                ours.get(name)
                    .is_some_and(|entry| theirs.get(name) == Some(entry))
            };
        Ok(config
            .contexts
            .iter()
            .filter(|named| {
                named.context.as_ref().is_some_and(|context| {
                    let user = context.user.as_deref().filter(|user| !user.is_empty());
                    !held(&self.clusters, &now.clusters, &context.cluster)
                        || user.is_some_and(|user| !held(&self.users, &now.users, user))
                })
            })
            .map(|named| named.name.clone())
            .collect())
    }
}

fn by_name<'a, T: Serialize + 'a>(
    entries: impl Iterator<Item = (&'a String, &'a T)>,
) -> BTreeMap<String, Value> {
    let mut named = BTreeMap::new();
    for (name, entry) in entries {
        named
            .entry(name.clone())
            .or_insert_with(|| serde_json::to_value(entry).expect("a kubeconfig entry as JSON"));
    }
    named
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROXY: &str = r#"{
  "apiVersion": "v1",
  "kind": "Config",
  "clusters": [
    {"name": "dev", "cluster": {"server": "https://127.0.0.1:1/dev", "certificate-authority-data": "Q0E="}},
    {"name": "prod", "cluster": {"server": "https://127.0.0.1:1/prod", "certificate-authority-data": "Q0E="}}
  ],
  "users": [
    {"name": "dev", "user": {"token": "a"}},
    {"name": "prod", "user": {"token": "b"}}
  ],
  "contexts": [
    {"name": "dev", "context": {"cluster": "dev", "user": "dev"}},
    {"name": "prod", "context": {"cluster": "prod", "user": "prod", "namespace": "apps"}}
  ],
  "current-context": "dev"
}"#;

    const CLUSTERS: &str = "- cluster:
    certificate-authority-data: Q0E=
    server: https://127.0.0.1:1/dev
  name: dev
- cluster:
    certificate-authority-data: Q0E=
    server: https://127.0.0.1:1/prod
  name: prod
";
    const CONTEXTS: &str = "- context:
    cluster: dev
    user: dev
  name: dev
- context:
    cluster: dev
    user: dev
    namespace: tools
  name: dev-tools
- context:
    cluster: prod
    namespace: edited
    user: prod
  name: prod
";
    const USERS: &str = "- name: dev
  user:
    token: a
- name: prod
  user:
    token: b
";
    const EKS_CLUSTER: &str = "- cluster:
    server: https://eks.example
  name: eks
";
    const EKS_CONTEXT: &str = "- context:
    cluster: eks
    user: eks
  name: eks
";
    const EKS_USER: &str = "- name: eks
  user:
    exec:
      apiVersion: client.authentication.k8s.io/v1beta1
      command: aws
";

    fn rewritten(clusters: &str, contexts: &str, users: &str) -> String {
        format!(
            "apiVersion: v1\nclusters:\n{clusters}contexts:\n{contexts}current-context: dev\nkind: Config\npreferences: {{}}\nusers:\n{users}"
        )
    }

    fn past(text: &str) -> Vec<String> {
        Reach::of(PROXY)
            .unwrap()
            .past(text)
            .unwrap()
            .into_iter()
            .collect()
    }

    #[test]
    fn the_entries_as_written_or_rewritten_with_new_names_and_namespaces_reach_nothing_past_them() {
        assert!(past(PROXY).is_empty());
        assert!(past(&rewritten(CLUSTERS, CONTEXTS, USERS)).is_empty());
    }

    #[test]
    fn a_tool_s_new_context_and_one_that_replaced_an_entry_reach_past_them() {
        let clusters = format!("{CLUSTERS}{EKS_CLUSTER}");
        let users = format!("{USERS}{EKS_USER}");
        let added = rewritten(&clusters, &format!("{CONTEXTS}{EKS_CONTEXT}"), &users);
        assert_eq!(past(&added), ["eks"]);
        let aliased = CONTEXTS.replace(
            "    cluster: prod\n    namespace: edited\n    user: prod\n",
            "    cluster: eks\n    user: eks\n",
        );
        assert_eq!(past(&rewritten(&clusters, &aliased, &users)), ["prod"]);
    }

    #[test]
    fn a_cluster_or_user_entry_rewritten_in_place_takes_its_contexts_past_them() {
        let server = CLUSTERS.replace("https://127.0.0.1:1/prod", "https://prod.example");
        assert_eq!(past(&rewritten(&server, CONTEXTS, USERS)), ["prod"]);
        let token = USERS.replace("token: a", "token: mine");
        assert_eq!(
            past(&rewritten(CLUSTERS, CONTEXTS, &token)),
            ["dev", "dev-tools"]
        );
    }
}
