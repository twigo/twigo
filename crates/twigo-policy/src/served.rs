//! Whether kube-apiserver serves a group-version itself (ARCHITECTURE 6.4),
//! which decides whether a dry run to it is one: an aggregated server may
//! ignore `dryRun` and perform the write. Its own groups count as its own
//! without a read; of any other, senders read the APIService as their actor
//! and keep the answer here, by context and connection, where the gate's
//! classification and the approval broker find the same answer.

use std::collections::HashMap;
use std::sync::{Mutex, MutexGuard};

use jiff::{SignedDuration, Timestamp};

/// How long an answer is kept, by the wall clock, which runs on while the
/// machine sleeps.
const KEPT_FOR: SignedDuration = SignedDuration::from_mins(5);

/// The groups kube-apiserver serves from its own storage in a release Twigo
/// supports, the core group first. Only an admin who deliberately points an
/// APIService of one elsewhere could make that wrong, and the policy guards
/// against accidents, not deliberate acts.
const BUILT_IN: [&str; 24] = [
    "",
    "admissionregistration.k8s.io",
    "apiextensions.k8s.io",
    "apiregistration.k8s.io",
    "apps",
    "authentication.k8s.io",
    "authorization.k8s.io",
    "autoscaling",
    "batch",
    "certificates.k8s.io",
    "coordination.k8s.io",
    "discovery.k8s.io",
    "events.k8s.io",
    "flowcontrol.apiserver.k8s.io",
    "internal.apiserver.k8s.io",
    "lifecycle.k8s.io",
    "networking.k8s.io",
    "node.k8s.io",
    "policy",
    "rbac.authorization.k8s.io",
    "resource.k8s.io",
    "scheduling.k8s.io",
    "storage.k8s.io",
    "storagemigration.k8s.io",
];

/// Whether kube-apiserver serves `group` itself, with no APIService read.
pub(crate) fn built_in(group: &str) -> bool {
    BUILT_IN.contains(&group)
}

/// Who serves a group-version, as its APIService says.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Server {
    /// kube-apiserver: the APIService names no `spec.service`.
    Itself,
    /// The service its APIService names, which may not honour a dry run.
    Aggregated,
}

/// The answers read, by context, the context's connection the clients that
/// read it were built for, and APIService.
#[derive(Default)]
pub struct Served(Mutex<HashMap<Key, Kept>>);

type Key = (String, Option<u64>, String);

#[derive(Clone, Copy)]
struct Kept {
    server: Server,
    until: Timestamp,
}

impl Served {
    /// What is known of `group/version` on `context`; none when nothing read
    /// it in the last 5 minutes, or nothing could.
    pub fn get(
        &self,
        context: &str,
        connection: Option<u64>,
        group: &str,
        version: &str,
    ) -> Option<Server> {
        let key = (context.to_owned(), connection, api_service(group, version));
        self.kept()
            .get(&key)
            .filter(|kept| Timestamp::now() < kept.until)
            .map(|kept| kept.server)
    }

    pub fn keep(
        &self,
        context: &str,
        connection: Option<u64>,
        group: &str,
        version: &str,
        server: Server,
    ) {
        let key = (context.to_owned(), connection, api_service(group, version));
        let until = Timestamp::now()
            .saturating_add(KEPT_FOR)
            .unwrap_or(Timestamp::MAX);
        self.kept().insert(key, Kept { server, until });
    }

    fn kept(&self) -> MutexGuard<'_, HashMap<Key, Kept>> {
        self.0.lock().expect("served lock")
    }
}

/// The name of the APIService of `group/version`, which must be
/// `version.group`
/// ([`ValidateAPIService`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/kube-aggregator/pkg/apis/apiregistration/validation/validation.go#L36-L47)).
pub fn api_service(group: &str, version: &str) -> String {
    format!("{version}.{group}")
}
