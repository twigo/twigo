//! Which plugins may ask the person to sign in, from the exec entry alone:
//! a cold cache makes such a plugin open a browser or print a device code,
//! and none can be told to fail instead. `interactiveMode` says nothing
//! here: int128/kubelogin documents `Never` for a browser flow, and the
//! others leave it out. So only the plugins known never to ask run
//! unattended; every other one, an unknown command included, runs only
//! while Twigo's window has the focus.
//!
//! What each plugin does was read in its source at its latest release
//! (2026-11-01): Azure/kubelogin v0.2.22, int128/kubelogin v1.36.4,
//! pinniped v0.47.0, aws-cli 2.39.3, aws-iam-authenticator v0.7.24,
//! cloud-provider-gcp v37.2.3, doctl v2.1.0, oci-cli v3.95.1.

use std::path::Path;

/// Azure/kubelogin's `--login` values that read their secrets from flags,
/// the environment or another CLI's session.
const AZURE_SILENT: [&str; 7] = [
    "spn",
    "msi",
    "workloadidentity",
    "azurepipelines",
    "ropc",
    "azurecli",
    "azd",
];

pub(super) fn needs(command: &str, args: &[String], env: &[(String, String)]) -> bool {
    let name = Path::new(command)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(command);
    let has = |word: &str| args.iter().any(|arg| arg == word);
    let silent = match name {
        "aws" => has("eks") && has("get-token"),
        "aws-iam-authenticator" => has("token"),
        "gke-gcloud-auth-plugin" => true,
        "doctl" => {
            has("exec-credential")
                && flag(args, "--sso-issuer-url", None).is_none()
                && flag(args, "--sso-client-id", None).is_none()
        }
        "oci" => has("generate-token"),
        "pinniped" => has("login") && has("static"),
        "kubectl" if args.first().is_some_and(|arg| arg == "oidc-login") => oidc_login_silent(args),
        "kubectl-oidc_login" => oidc_login_silent(args),
        // Both projects ship a `kubelogin`; only int128's takes an issuer.
        "kubelogin" if flag(args, "--oidc-issuer-url", None).is_some() => oidc_login_silent(args),
        "kubelogin" => azure_silent(args, env),
        _ => false,
    };
    !silent
}

/// int128/kubelogin asks nobody only for client credentials, or for a
/// password grant given both the username and the password.
fn oidc_login_silent(args: &[String]) -> bool {
    match flag(args, "--grant-type", None) {
        Some("client-credentials") => true,
        Some("password") => {
            flag(args, "--username", None).is_some() && flag(args, "--password", None).is_some()
        }
        _ => false,
    }
}

/// Azure/kubelogin's login method: `AAD_LOGIN_METHOD` overrides `--login`
/// unless `--disable-environment-override` is given, and without either it
/// is `devicecode`.
fn azure_silent(args: &[String], env: &[(String, String)]) -> bool {
    let from_env = env
        .iter()
        .rev()
        .find(|(name, _)| name == "AAD_LOGIN_METHOD")
        .map(|(_, value)| value.as_str())
        .filter(|_| {
            !args
                .iter()
                .any(|arg| arg == "--disable-environment-override")
        });
    from_env
        .or_else(|| flag(args, "--login", Some("-l")))
        .is_some_and(|method| AZURE_SILENT.contains(&method))
}

/// A flag's value in pflag's forms: `--name value`, `--name=value`, and the
/// same for its short form.
fn flag<'a>(args: &'a [String], long: &str, short: Option<&str>) -> Option<&'a str> {
    let names = [Some(long), short];
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        for name in names.iter().flatten() {
            if arg == name {
                return args.next().map(String::as_str);
            }
            if let Some(value) = arg
                .strip_prefix(name)
                .and_then(|rest| rest.strip_prefix('='))
            {
                return Some(value);
            }
        }
    }
    None
}
