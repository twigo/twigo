//! The deprecated `auth-provider: oidc`, refreshed as client-go refreshes it
//! (`plugin/pkg/client/auth/oidc/oidc.go`): the id-token until 10 s before
//! its `exp`, then the issuer's discovery document and a `refresh_token`
//! grant. kubectl writes the new tokens back to the user's file, and the
//! file is the store every client shares: an IdP that rotates refresh tokens,
//! as Dex does by default, has spent the one in the file. So Twigo writes
//! them back too, though only the two values ([`persist`]).
//!
//! Unlike client-go, the new tokens go to memory first, so a write that
//! fails never throws the only valid refresh token away, and the user's
//! file is read again before each refresh, so a token kubectl got meanwhile
//! is taken rather than spent again.

mod persist;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use http::{StatusCode, Uri};
use jiff::{SignedDuration, Timestamp};
use kube::config::Kubeconfig;
use ring::digest::{SHA256, digest};
use secrecy::SecretString;
use serde::Deserialize;

use super::output::Credential;
use crate::client::ProxyEnv;
use crate::client::idp::{Idp, IdpError};

/// client-go's `expiryDelta`.
const SKEW: SignedDuration = SignedDuration::from_secs(10);

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum OidcError {
    #[error("Must provide {0}")]
    Missing(&'static str),
    #[error("the oidc idp-certificate-authority: {0}")]
    Authority(String),
    #[error("No valid id-token, and cannot refresh without refresh-token")]
    NoRefreshToken,
    #[error(transparent)]
    Idp(#[from] IdpError),
    #[error("oidc: failed to query metadata endpoint {uri}: {status} {body:?}")]
    Discovery {
        uri: String,
        status: StatusCode,
        body: String,
    },
    #[error("oidc: discovery object doesn't contain a token_endpoint")]
    NoTokenEndpoint,
    #[error("oidc: the refresh failed: {status} {body:?}")]
    Refresh { status: StatusCode, body: String },
    #[error(
        "token response did not contain an id_token, either the scope \"openid\" wasn't requested upon login, or the provider doesn't support id_tokens as part of the refresh response"
    )]
    NoIdToken,
    #[error("oidc: {0}")]
    Invalid(String),
}

/// The provider's settings, as the user entry holds them.
#[derive(Clone, PartialEq, Eq)]
pub struct OidcEntry {
    issuer: String,
    client_id: String,
    client_secret: String,
    id_token: Option<String>,
    refresh_token: Option<String>,
    /// PEM.
    ca: Option<Vec<u8>>,
}

impl std::fmt::Debug for OidcEntry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OidcEntry")
            .field("issuer", &self.issuer)
            .field("client_id", &self.client_id)
            .finish_non_exhaustive()
    }
}

impl OidcEntry {
    pub fn of(config: &HashMap<String, String>) -> Result<Self, OidcError> {
        let get = |key: &str| config.get(key).filter(|value| !value.is_empty()).cloned();
        let ca = match (
            get("idp-certificate-authority-data"),
            get("idp-certificate-authority"),
        ) {
            (Some(data), _) => Some(
                STANDARD
                    .decode(data.trim())
                    .map_err(|error| OidcError::Authority(error.to_string()))?,
            ),
            (None, Some(file)) => {
                Some(std::fs::read(file).map_err(|error| OidcError::Authority(error.to_string()))?)
            }
            (None, None) => None,
        };
        Ok(Self {
            issuer: get("idp-issuer-url").ok_or(OidcError::Missing("idp-issuer-url"))?,
            client_id: get("client-id").ok_or(OidcError::Missing("client-id"))?,
            client_secret: get("client-secret").unwrap_or_default(),
            id_token: get("id-token"),
            refresh_token: get("refresh-token"),
            ca,
        })
    }

    /// Identifies the provider whose tokens a source keeps: everything but
    /// the tokens, so a corrected secret or CA reaches a new source.
    pub(super) fn key(&self, origin: Option<&Path>, user: &str) -> String {
        let mut settings = Vec::new();
        for part in [
            origin
                .map(|path| path.as_os_str().as_encoded_bytes())
                .unwrap_or_default(),
            user.as_bytes(),
            self.issuer.as_bytes(),
            self.client_id.as_bytes(),
            self.client_secret.as_bytes(),
            self.ca.as_deref().unwrap_or_default(),
        ] {
            settings.extend_from_slice(&(part.len() as u64).to_be_bytes());
            settings.extend_from_slice(part);
        }
        digest(&SHA256, &settings)
            .as_ref()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect()
    }
}

/// How the token endpoint takes the client's credentials, as Go's oauth2
/// finds out: the `Authorization` header first, then the form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Style {
    Header,
    Form,
}

pub struct Oidc {
    /// The file the user entry comes from, which the tokens go back to.
    origin: Option<PathBuf>,
    user: String,
    env: tokio::sync::watch::Receiver<Option<Arc<twigo_env::ShellEnv>>>,
    state: Mutex<State>,
    refreshing: tokio::sync::Mutex<()>,
}

struct State {
    entry: OidcEntry,
    /// The credential of `entry.id_token`, so a rejection names it.
    current: Option<Arc<Credential>>,
    style: Option<Style>,
    /// The id-token is one this source's refresh got, so a rejection keeps
    /// it rather than spend another refresh token and write the file again
    /// on every request; client-go never refreshes on a 401.
    fresh: bool,
    /// The server rejected an id-token that no refresh can replace, a fresh
    /// one or one without a refresh token: the next request reads the
    /// user's file again, so a token the person got by signing in elsewhere
    /// replaces it.
    reread: bool,
    /// The server rejected an id-token from the file: the next request reads
    /// the file again, then refreshes once; if the issuer refuses, the
    /// token stays while it lasts, as client-go keeps it.
    retry: bool,
    /// The id-token and refresh token the user's file held when this source
    /// last read or wrote it: only tokens someone else wrote since are taken
    /// from it, never ones it still holds after a failed write or a
    /// rejection.
    on_disk: (Option<String>, Option<String>),
}

impl std::fmt::Debug for Oidc {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Oidc")
            .field("user", &self.user)
            .finish_non_exhaustive()
    }
}

impl Oidc {
    pub(super) fn new(
        origin: Option<PathBuf>,
        user: String,
        entry: OidcEntry,
        env: tokio::sync::watch::Receiver<Option<Arc<twigo_env::ShellEnv>>>,
    ) -> Self {
        Self {
            origin,
            user,
            env,
            state: Mutex::new(State {
                on_disk: (entry.id_token.clone(), entry.refresh_token.clone()),
                entry,
                current: None,
                style: None,
                fresh: false,
                reread: false,
                retry: false,
            }),
            refreshing: tokio::sync::Mutex::new(()),
        }
    }

    /// The id-token while it lasts, else a refreshed one; one refresh at a
    /// time, so a rotated refresh token is never spent twice.
    pub async fn credential(&self) -> Result<Arc<Credential>, OidcError> {
        let pending = {
            let state = self.state();
            state.reread || state.retry
        };
        if pending {
            let _one = self.refreshing.lock().await;
            let (reread, retry) = {
                let mut state = self.state();
                (
                    std::mem::take(&mut state.reread),
                    std::mem::take(&mut state.retry),
                )
            };
            if reread || retry {
                self.read_back();
            }
            // Reading back drops `current` when the file holds a newer token.
            if retry && self.state().current.is_some() {
                match self.refresh_now().await {
                    Ok(credential) => return Ok(credential),
                    Err(error) => eprintln!(
                        "kept the rejected oidc token of {}, since its refresh failed: {error}",
                        self.user
                    ),
                }
            }
        }
        if let Some(credential) = self.valid() {
            return Ok(credential);
        }
        let _one = self.refreshing.lock().await;
        if let Some(credential) = self.valid() {
            return Ok(credential);
        }
        self.read_back();
        if let Some(credential) = self.valid() {
            return Ok(credential);
        }
        self.refresh_now().await
    }

    /// Refreshes, keeps the new tokens and writes them back; the caller
    /// holds `refreshing`.
    async fn refresh_now(&self) -> Result<Arc<Credential>, OidcError> {
        let entry = self.state().entry.clone();
        let refresh_token = entry
            .refresh_token
            .clone()
            .ok_or(OidcError::NoRefreshToken)?;
        let tokens = self.refresh(&entry, &refresh_token).await?;
        let rotated = tokens
            .refresh_token
            .filter(|token| !token.is_empty() && *token != refresh_token);
        let credential = {
            let mut state = self.state();
            state.entry.id_token = Some(tokens.id_token.clone());
            if let Some(rotated) = &rotated {
                state.entry.refresh_token = Some(rotated.clone());
            }
            state.current = None;
            state.fresh = true;
            drop(state);
            self.valid()
        };
        if let Some(origin) = self.origin.clone() {
            let user = self.user.clone();
            let id_token = tokens.id_token;
            let written_id = id_token.clone();
            let written_refresh = rotated.clone();
            let written = tokio::task::spawn_blocking(move || {
                persist::write(
                    &origin,
                    &user,
                    &entry.issuer,
                    &entry.client_id,
                    &id_token,
                    written_refresh.as_deref(),
                )
                .map_err(|error| (origin, error))
            })
            .await
            .expect("the write does not panic");
            match written {
                Ok(()) => {
                    let mut state = self.state();
                    let refresh = rotated.or_else(|| state.on_disk.1.clone());
                    state.on_disk = (Some(written_id), refresh);
                }
                Err((origin, error)) => eprintln!(
                    "kept the refreshed oidc tokens of {} in memory only: {}: {error}",
                    self.user,
                    origin.display()
                ),
            }
        }
        credential
            .ok_or_else(|| OidcError::Invalid("the issuer returned an expired id-token".to_owned()))
    }

    /// Notes that the server rejected `used`: the next request takes a newer
    /// token from the user's file, else refreshes once if a refresh can
    /// replace it; `used` stays until something does.
    pub fn reject(&self, used: &Arc<Credential>) {
        let mut state = self.state();
        if !state
            .current
            .as_ref()
            .is_some_and(|current| Arc::ptr_eq(current, used))
        {
            return;
        }
        if state.fresh || state.entry.refresh_token.is_none() {
            state.reread = true;
        } else {
            state.retry = true;
        }
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("oidc lock")
    }

    fn valid(&self) -> Option<Arc<Credential>> {
        let mut state = self.state();
        if let Some(current) = &state.current
            && current
                .expires()
                .is_some_and(|exp| Timestamp::now() + SKEW < exp)
        {
            return Some(Arc::clone(current));
        }
        let token = state.entry.id_token.clone()?;
        let expires = expiry(&token)?;
        if Timestamp::now() + SKEW >= expires {
            return None;
        }
        let credential = Arc::new(Credential {
            token: Some(SecretString::from(token)),
            identity: None,
            expires: Some(expires),
        });
        state.current = Some(Arc::clone(&credential));
        Some(credential)
    }

    /// Takes the tokens in the user's file when kubectl, or another Twigo,
    /// wrote new ones since this source last saw it.
    fn read_back(&self) {
        let Some(origin) = &self.origin else {
            return;
        };
        let Ok(config) = Kubeconfig::read_from(origin) else {
            return;
        };
        let Some(provider) = config
            .auth_infos
            .iter()
            .find(|named| named.name == self.user)
            .and_then(|named| named.auth_info.as_ref())
            .and_then(|user| user.auth_provider.as_ref())
            .filter(|provider| provider.name == "oidc")
        else {
            return;
        };
        let Ok(on_disk) = OidcEntry::of(&provider.config) else {
            return;
        };
        let mut state = self.state();
        if on_disk.issuer != state.entry.issuer || on_disk.client_id != state.entry.client_id {
            return;
        }
        let found = (on_disk.id_token, on_disk.refresh_token);
        if found == state.on_disk {
            return;
        }
        if found.0.is_some() && found.0 != state.entry.id_token {
            state.entry.id_token.clone_from(&found.0);
            state.current = None;
            state.fresh = false;
        }
        if found.1.is_some() {
            state.entry.refresh_token.clone_from(&found.1);
        }
        state.on_disk = found;
    }

    async fn refresh(&self, entry: &OidcEntry, refresh_token: &str) -> Result<Tokens, OidcError> {
        let issuer: Uri = entry
            .issuer
            .parse()
            .map_err(|error| OidcError::Invalid(format!("idp-issuer-url: {error}")))?;
        let env = self.env.borrow().clone();
        let var = |name: &str| env.as_ref()?.get(name)?.to_str().map(str::to_owned);
        let idp = Idp::new(&issuer, entry.ca.as_deref(), &ProxyEnv::from_vars(var))?;
        let endpoint = discover(&idp, &entry.issuer).await?;
        let grant = [
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ];
        let styles = match self.state().style {
            Some(style) => vec![style],
            None => vec![Style::Header, Style::Form],
        };
        let mut failure = None;
        for style in styles {
            let (body, basic) = match style {
                Style::Header => (
                    encode(&grant),
                    Some(format!(
                        "Basic {}",
                        STANDARD.encode(format!(
                            "{}:{}",
                            escape(&entry.client_id),
                            escape(&entry.client_secret)
                        ))
                    )),
                ),
                Style::Form => {
                    let mut pairs = grant.to_vec();
                    pairs.push(("client_id", &entry.client_id));
                    if !entry.client_secret.is_empty() {
                        pairs.push(("client_secret", &entry.client_secret));
                    }
                    (encode(&pairs), None)
                }
            };
            let (status, response) = idp.post_form(&endpoint, body, basic).await?;
            if status.is_success() {
                self.state().style = Some(style);
                let tokens: TokenResponse = serde_json::from_slice(&response)
                    .map_err(|error| OidcError::Invalid(format!("the token response: {error}")))?;
                let id_token = tokens
                    .id_token
                    .filter(|token| !token.is_empty())
                    .ok_or(OidcError::NoIdToken)?;
                return Ok(Tokens {
                    id_token,
                    refresh_token: tokens.refresh_token,
                });
            }
            failure = Some(OidcError::Refresh {
                status,
                body: snippet(&response),
            });
        }
        Err(failure.expect("at least one style was tried"))
    }
}

struct Tokens {
    id_token: String,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct TokenResponse {
    id_token: Option<String>,
    refresh_token: Option<String>,
}

#[derive(Deserialize)]
struct Discovery {
    token_endpoint: Option<String>,
}

async fn discover(idp: &Idp, issuer: &str) -> Result<Uri, OidcError> {
    let uri = format!(
        "{}/.well-known/openid-configuration",
        issuer.trim_end_matches('/')
    );
    let parsed: Uri = uri
        .parse()
        .map_err(|error| OidcError::Invalid(format!("{uri}: {error}")))?;
    let (status, body) = idp.get(&parsed).await?;
    if status != StatusCode::OK {
        return Err(OidcError::Discovery {
            uri,
            status,
            body: snippet(&body),
        });
    }
    let discovery: Discovery = serde_json::from_slice(&body)
        .map_err(|error| OidcError::Invalid(format!("the discovery document: {error}")))?;
    discovery
        .token_endpoint
        .filter(|endpoint| !endpoint.is_empty())
        .ok_or(OidcError::NoTokenEndpoint)?
        .parse()
        .map_err(|error| OidcError::Invalid(format!("token_endpoint: {error}")))
}

/// The JWT's `exp`, an integer or a float, as client-go reads it unverified.
fn expiry(token: &str) -> Option<Timestamp> {
    let payload = token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let exp = claims.get("exp")?.as_f64()?;
    Timestamp::from_second(exp.trunc() as i64).ok()
}

fn encode(pairs: &[(&str, &str)]) -> String {
    form_urlencoded::Serializer::new(String::new())
        .extend_pairs(pairs)
        .finish()
}

/// Go's `url.QueryEscape`, which oauth2 applies to the client's id and
/// secret in the header (RFC 6749 2.3.1).
fn escape(value: &str) -> String {
    form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// The start of a response, as client-go quotes it.
fn snippet(body: &[u8]) -> String {
    String::from_utf8_lossy(&body[..body.len().min(80)]).into_owned()
}
