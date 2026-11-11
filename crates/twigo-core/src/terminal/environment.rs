//! A terminal's environment: the login shell's, without Twigo's own
//! `TWIGO_*`, with what a terminal says of itself, its `KUBECONFIG`, and a
//! UTF-8 `LANG` where no locale variable names UTF-8; VS Code reads `LANG`
//! alone ([`shouldSetLangEnvVariable`]).
//!
//! [`shouldSetLangEnvVariable`]: https://github.com/microsoft/vscode/blob/1.145.2/src/vs/workbench/contrib/terminal/common/terminalEnvironment.ts#L98-L107

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};

use twigo_env::ShellEnv;

const LOCALE: [&str; 3] = ["LC_ALL", "LC_CTYPE", "LANG"];

pub(super) fn environment(
    login: &ShellEnv,
    kubeconfig: &OsStr,
    utf8_locale: impl FnOnce() -> String,
) -> Vec<(OsString, OsString)> {
    let mut env: BTreeMap<OsString, OsString> = login
        .iter()
        .filter(|(name, _)| !name.as_encoded_bytes().starts_with(b"TWIGO_"))
        .map(|(name, value)| (name.to_owned(), value.to_owned()))
        .collect();
    let version = env!("CARGO_PKG_VERSION");
    for (name, value) in [
        ("TERM", "xterm-256color"),
        ("COLORTERM", "truecolor"),
        ("TERM_PROGRAM", "Twigo"),
        ("TERM_PROGRAM_VERSION", version),
    ] {
        env.insert(name.into(), value.into());
    }
    env.insert("KUBECONFIG".into(), kubeconfig.to_owned());
    let utf8 = LOCALE.iter().any(|name| {
        env.get(OsStr::new(name))
            .is_some_and(|value| names_utf8(value))
    });
    if !utf8 {
        env.insert("LANG".into(), utf8_locale().into());
    }
    env.into_iter().collect()
}

/// `en_US.UTF-8`, `C.utf8`, `uk_UA.UTF-8@euro`.
fn names_utf8(locale: &OsStr) -> bool {
    let locale = locale.to_string_lossy().to_ascii_lowercase();
    locale.contains("utf-8") || locale.contains("utf8")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn login(vars: &[(&str, &str)]) -> ShellEnv {
        vars.iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    fn get<'a>(env: &'a [(OsString, OsString)], name: &str) -> Option<&'a str> {
        env.iter()
            .find(|(found, _)| found == name)
            .and_then(|(_, value)| value.to_str())
    }

    #[test]
    fn it_is_the_login_shell_s_without_twigo_s_own_and_with_the_terminal_s() {
        let env = environment(
            &login(&[
                ("PATH", "/opt/homebrew/bin:/usr/bin"),
                ("TWIGO_KUBECONFIG", "/tmp/kind"),
                ("TERM", "dumb"),
                ("KUBECONFIG", "/home/me/.kube/config"),
                ("LANG", "en_GB.UTF-8"),
            ]),
            OsStr::new("/data/terminals/1/kubeconfig:/home/me/.kube/config"),
            || unreachable!("LANG names UTF-8"),
        );
        assert_eq!(get(&env, "PATH"), Some("/opt/homebrew/bin:/usr/bin"));
        assert_eq!(get(&env, "TWIGO_KUBECONFIG"), None);
        assert_eq!(get(&env, "TERM"), Some("xterm-256color"));
        assert_eq!(get(&env, "COLORTERM"), Some("truecolor"));
        assert_eq!(get(&env, "TERM_PROGRAM"), Some("Twigo"));
        assert_eq!(
            get(&env, "TERM_PROGRAM_VERSION"),
            Some(env!("CARGO_PKG_VERSION"))
        );
        assert_eq!(
            get(&env, "KUBECONFIG"),
            Some("/data/terminals/1/kubeconfig:/home/me/.kube/config")
        );
        assert_eq!(get(&env, "LANG"), Some("en_GB.UTF-8"));
    }

    #[test]
    fn lang_comes_in_utf_8_only_where_no_locale_variable_names_it() {
        let utf8 = || "uk_UA.UTF-8".to_owned();
        let lang = |vars: &[(&str, &str)]| {
            let env = environment(&login(vars), OsStr::new("k"), utf8);
            get(&env, "LANG").map(str::to_owned)
        };
        assert_eq!(lang(&[]).as_deref(), Some("uk_UA.UTF-8"));
        assert_eq!(lang(&[("LANG", "C")]).as_deref(), Some("uk_UA.UTF-8"));
        assert_eq!(lang(&[("LANG", "C.utf8")]).as_deref(), Some("C.utf8"));
        assert_eq!(
            lang(&[("LANG", "en_US"), ("LC_CTYPE", "en_US.UTF-8")]).as_deref(),
            Some("en_US")
        );
        assert_eq!(lang(&[("LC_ALL", "de_DE.utf-8")]), None);
    }
}
