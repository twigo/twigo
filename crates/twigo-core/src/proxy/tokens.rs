//! A process's tokens (ARCHITECTURE 6.4): 32 random bytes each, one per
//! process and context, kept only by their SHA-256 digest, which a request's
//! token is looked up by.

use std::sync::Arc;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ring::digest::{SHA256, digest};
use ring::rand::{SecureRandom, SystemRandom};
use tokio_util::sync::CancellationToken;
use twigo_kube::client::Actor;

pub(crate) type Digest = [u8; 32];

/// A token as its kubeconfig holds it, written once and dropped: it has no
/// `Debug`, so nothing prints it.
pub(super) struct Token(String);

impl Token {
    pub(super) fn new() -> Self {
        let mut bytes = [0; 32];
        SystemRandom::new()
            .fill(&mut bytes)
            .expect("the OS's random source");
        Self(URL_SAFE_NO_PAD.encode(bytes))
    }

    pub(super) fn digest(&self) -> Digest {
        of(&self.0)
    }

    pub(super) fn as_str(&self) -> &str {
        &self.0
    }
}

/// The digest a token is kept by.
pub(super) fn of(token: &str) -> Digest {
    digest(&SHA256, token.as_bytes())
        .as_ref()
        .try_into()
        .expect("SHA-256 is 32 bytes")
}

/// The path prefix of a context through the proxy: `[a-z0-9]+`, from its
/// name and its connection, so that kubectl's discovery cache, which keeps a
/// directory per server URL with every other character turned into `_`
/// ([`computeDiscoverCacheDir`]), never answers for another context, nor for
/// another cluster the same name moves to.
///
/// [`computeDiscoverCacheDir`]: https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/cli-runtime/pkg/genericclioptions/config_flags.go#L514-L522
pub(super) fn prefix(context: &str, connection: u64) -> String {
    let mut named = Vec::with_capacity(context.len() + 16);
    named.extend_from_slice(&(context.len() as u64).to_be_bytes());
    named.extend_from_slice(context.as_bytes());
    named.extend_from_slice(&connection.to_be_bytes());
    digest(&SHA256, &named).as_ref()[..8]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// What a token maps to.
pub(crate) struct Holder {
    pub process: u64,
    /// As Twigo named the process: `Terminal 2`.
    pub label: Arc<str>,
    /// The window its asks go to; none denies them all.
    pub window: Option<Arc<str>>,
    pub actor: Actor,
    pub context: String,
    /// The context's connection when the token was given: the token never
    /// reaches another.
    pub connection: u64,
    /// Its context's path prefix, without the slash.
    pub prefix: String,
    pub digest: Digest,
    /// Cancelled once the process's handle drops.
    pub ended: CancellationToken,
}

#[cfg(test)]
mod tests {
    use std::collections::HashSet;

    use super::*;

    #[test]
    fn a_token_is_32_random_bytes_in_base64url_kept_by_its_digest() {
        let tokens: Vec<Token> = (0..100).map(|_| Token::new()).collect();
        for token in &tokens {
            assert_eq!(token.as_str().len(), 43, "32 bytes, no padding");
            let bytes = URL_SAFE_NO_PAD.decode(token.as_str()).unwrap();
            assert_eq!(bytes.len(), 32);
            assert_eq!(token.digest(), of(token.as_str()));
        }
        let distinct: HashSet<&str> = tokens.iter().map(Token::as_str).collect();
        assert_eq!(distinct.len(), 100);
    }

    #[test]
    fn a_prefix_is_lowercase_letters_and_digits_of_the_name_and_the_connection() {
        let id = prefix("kind-a", 7);
        assert!(
            id.chars()
                .all(|c| c.is_ascii_digit() || c.is_ascii_lowercase()),
            "{id}"
        );
        assert_eq!(id, prefix("kind-a", 7));
        assert_ne!(id, prefix("kind-a", 8), "another cluster behind the name");
        assert_ne!(id, prefix("kind-b", 7));
    }
}
