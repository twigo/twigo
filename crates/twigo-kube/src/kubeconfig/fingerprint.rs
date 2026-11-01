use std::hash::{DefaultHasher, Hash, Hasher};

use kube::config::{NamedAuthInfo, NamedCluster, NamedContext};
use serde::Serialize;

/// What a context's connection is built from: its context, cluster and user
/// entries and the files they reference (ARCHITECTURE 6.3). Contexts whose
/// fingerprint stays the same keep their clients.
///
/// It lives in memory only: `DefaultHasher::new` hashes alike within a
/// build, not across Rust releases.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Fingerprint(u64);

impl Fingerprint {
    pub(super) fn of(
        context: &NamedContext,
        cluster: Option<&NamedCluster>,
        user: Option<&NamedAuthInfo>,
    ) -> Self {
        let mut hasher = DefaultHasher::new();
        entry(&mut hasher, context);
        entry(&mut hasher, &cluster);
        entry(&mut hasher, &without_oidc_tokens(user));
        let cluster = cluster.and_then(|named| named.cluster.as_ref());
        let user = user.and_then(|named| named.auth_info.as_ref());
        let files = [
            cluster.and_then(|c| c.certificate_authority.as_deref()),
            user.and_then(|u| u.client_certificate.as_deref()),
            user.and_then(|u| u.client_key.as_deref()),
            user.and_then(|u| u.token_file.as_deref()),
        ];
        for file in files.into_iter().flatten() {
            file.hash(&mut hasher);
            match std::fs::read(file) {
                Ok(bytes) => bytes.hash(&mut hasher),
                Err(error) => error.kind().hash(&mut hasher),
            }
        }
        Self(hasher.finish())
    }
}

/// Hashes an entry through `serde_json::Value`, whose maps sort their keys:
/// a user's `as-user-extra` is a `HashMap`, whose order changes from one
/// read to the next.
fn entry(hasher: &mut DefaultHasher, entry: &impl Serialize) {
    let value = serde_json::to_value(entry).expect("a kubeconfig entry serializes to JSON");
    value.to_string().hash(hasher);
}

/// The user entry without its oidc tokens, which Twigo refreshes and writes
/// back itself: a new token changes nothing about the connection.
fn without_oidc_tokens(user: Option<&NamedAuthInfo>) -> Option<NamedAuthInfo> {
    let mut user = user?.clone();
    if let Some(provider) = user
        .auth_info
        .as_mut()
        .and_then(|info| info.auth_provider.as_mut())
        .filter(|provider| provider.name == "oidc")
    {
        provider.config.remove("id-token");
        provider.config.remove("refresh-token");
    }
    Some(user)
}
