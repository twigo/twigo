//! How each login shell is asked to run a command line of external programs.

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

/// The command-line language of a shell, by its file name.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Syntax {
    /// sh, bash, zsh, dash, ksh and any shell not named below.
    Posix,
    Fish,
    Nu,
    Xonsh,
    Pwsh,
}

impl Syntax {
    pub(crate) fn of(shell: &Path) -> Self {
        match shell.file_name().and_then(OsStr::to_str) {
            Some("fish") => Self::Fish,
            Some("nu") => Self::Nu,
            Some("xonsh") => Self::Xonsh,
            Some("pwsh" | "pwsh-preview") => Self::Pwsh,
            _ => Self::Posix,
        }
    }

    /// The arguments that make the shell read its login and interactive
    /// startup files, then run `calls` one after another.
    pub(crate) fn args(self, calls: &[&[&OsStr]]) -> Vec<OsString> {
        let line = calls
            .iter()
            .map(|call| self.call(call))
            .collect::<Vec<_>>()
            .join(&b"; "[..]);
        let flags: &[&str] = match self {
            // pwsh reads its profile unless told not to; -Login must come first.
            Self::Pwsh => &["-Login", "-Command"],
            Self::Posix | Self::Fish | Self::Nu | Self::Xonsh => &["-i", "-l", "-c"],
        };
        flags
            .iter()
            .map(OsString::from)
            .chain([OsString::from_vec(line)])
            .collect()
    }

    fn call(self, words: &[&OsStr]) -> Vec<u8> {
        let quoted = words
            .iter()
            .map(|word| self.quote(word.as_bytes()))
            .collect::<Vec<_>>()
            .join(&b' ');
        match self {
            Self::Posix | Self::Fish => quoted,
            // `^` runs a quoted word as an external command.
            Self::Nu => [b"^".as_slice(), &quoted].concat(),
            // A line starting with a string literal would be Python.
            Self::Xonsh => [b"![".as_slice(), &quoted, b"]"].concat(),
            Self::Pwsh => [b"& ".as_slice(), &quoted].concat(),
        }
    }

    fn quote(self, word: &[u8]) -> Vec<u8> {
        match self {
            Self::Posix => single_quoted(word, b"'\\''"),
            Self::Pwsh => single_quoted(word, b"''"),
            // fish's single quotes and Python's both escape `\` and `'`.
            Self::Fish | Self::Xonsh => {
                let mut out = vec![b'\''];
                for &byte in word {
                    if matches!(byte, b'\\' | b'\'') {
                        out.push(b'\\');
                    }
                    out.push(byte);
                }
                out.push(b'\'');
                out
            }
            // A raw string, with more `#` than any `'#…` inside it.
            Self::Nu => {
                let mut hashes = b"#".to_vec();
                while contains(word, &[b"'".as_slice(), &hashes].concat()) {
                    hashes.push(b'#');
                }
                [b"r", &hashes[..], b"'", word, b"'", &hashes[..]].concat()
            }
        }
    }
}

fn single_quoted(word: &[u8], quote: &[u8]) -> Vec<u8> {
    let mut out = vec![b'\''];
    for &byte in word {
        if byte == b'\'' {
            out.extend_from_slice(quote);
        } else {
            out.push(byte);
        }
    }
    out.push(b'\'');
    out
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = r"/opt/a b'c\d/twigo";

    fn args(shell: &str) -> Vec<String> {
        let calls: &[&[&OsStr]] = &[
            &[OsStr::new(EXE), OsStr::new("--dump-env"), OsStr::new("m")],
            &[OsStr::new("/usr/bin/env"), OsStr::new("-0")],
        ];
        Syntax::of(Path::new(shell))
            .args(calls)
            .into_iter()
            .map(|arg| arg.into_string().expect("UTF-8"))
            .collect()
    }

    #[test]
    fn posix_shells_close_and_reopen_single_quotes() {
        let line = r"'/opt/a b'\''c\d/twigo' '--dump-env' 'm'; '/usr/bin/env' '-0'";
        for shell in ["/bin/bash", "/bin/zsh", "/bin/sh", "/usr/local/bin/unknown"] {
            assert_eq!(args(shell), ["-i", "-l", "-c", line], "{shell}");
        }
    }

    #[test]
    fn fish_escapes_backslashes_and_quotes() {
        assert_eq!(
            args("/opt/homebrew/bin/fish"),
            [
                "-i",
                "-l",
                "-c",
                r"'/opt/a b\'c\\d/twigo' '--dump-env' 'm'; '/usr/bin/env' '-0'"
            ]
        );
    }

    #[test]
    fn nushell_runs_raw_strings_as_externals() {
        assert_eq!(
            args("/usr/local/bin/nu"),
            [
                "-i",
                "-l",
                "-c",
                r"^r#'/opt/a b'c\d/twigo'# r#'--dump-env'# r#'m'#; ^r#'/usr/bin/env'# r#'-0'#"
            ]
        );
    }

    #[test]
    fn nushell_adds_hashes_past_a_quote_and_hash_in_the_word() {
        assert_eq!(Syntax::Nu.quote(b"a'#b'##c"), b"r###'a'#b'##c'###".to_vec());
    }

    #[test]
    fn xonsh_runs_python_strings_in_subprocess_mode() {
        assert_eq!(
            args("/usr/bin/xonsh"),
            [
                "-i",
                "-l",
                "-c",
                r"!['/opt/a b\'c\\d/twigo' '--dump-env' 'm']; !['/usr/bin/env' '-0']"
            ]
        );
    }

    #[test]
    fn pwsh_doubles_single_quotes_and_logs_in_first() {
        let line = r"& '/opt/a b''c\d/twigo' '--dump-env' 'm'; & '/usr/bin/env' '-0'";
        for shell in ["/usr/local/bin/pwsh", "/usr/local/bin/pwsh-preview"] {
            assert_eq!(args(shell), ["-Login", "-Command", line], "{shell}");
        }
    }
}
