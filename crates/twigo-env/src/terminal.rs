//! How a terminal starts a shell so that the terminal's `KUBECONFIG` holds
//! after the shell's own startup files, as VS Code's shell integration runs
//! its own after them ([`getShellIntegrationInjection`]): Twigo's files take
//! the place of the shell's, run the person's as the shell would, errors and
//! all, and then set it. zsh reads Twigo's from `ZDOTDIR`, bash from
//! `--init-file`; fish runs `--init-command` after its configuration, and
//! pwsh `-Command` after its profile. Any other shell starts as it would,
//! and a startup file of it that sets `KUBECONFIG` replaces the terminal's.
//!
//! [`getShellIntegrationInjection`]: https://github.com/microsoft/vscode/blob/1.145.2/src/vs/platform/terminal/node/terminalEnvironment.ts#L52-L277

use std::ffi::{OsStr, OsString};
use std::os::unix::ffi::{OsStrExt, OsStringExt};
use std::path::Path;

use crate::shell::Syntax;

/// How a terminal starts a shell that keeps its `KUBECONFIG`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Startup {
    /// In place of the arguments it would start with.
    pub args: Vec<OsString>,
    /// Set in its environment, over the terminal's.
    pub env: Vec<(OsString, OsString)>,
    /// Written into the terminal's directory before it starts, by name.
    pub files: Vec<(&'static str, Vec<u8>)>,
}

#[derive(Clone, Copy)]
enum Shell {
    Zsh,
    Bash,
    Fish,
    Pwsh,
}

/// zsh's startup files in the order it reads them, and when it reads the
/// next: as a login shell, an interactive one, or both, and only while the
/// option `rcs` is set, which a startup file may unset ([`run_init_scripts`]).
///
/// [`run_init_scripts`]: https://github.com/zsh-users/zsh/blob/zsh-5.9/Src/init.c#L1296-L1370
const ZSH: [(&str, Option<&str>); 4] = [
    (".zshenv", Some("-o rcs && ( -o login || -o interactive )")),
    (".zprofile", Some("-o rcs")),
    (".zshrc", Some("-o rcs && -o login")),
    (".zlogin", None),
];

/// bash's file in the terminal's directory.
const BASH: &str = "bashrc";

impl Startup {
    /// How a terminal starts `shell`, which it would start with `args`, the
    /// login flag or none, so that `kubeconfig` is the shell's `KUBECONFIG`
    /// once its startup files ran; `dir` is the terminal's own directory,
    /// and `zdotdir` the person's `ZDOTDIR`, where zsh reads their files.
    /// None for any other shell or arguments.
    pub fn of(
        shell: &Path,
        args: &[OsString],
        kubeconfig: &OsStr,
        dir: &Path,
        zdotdir: Option<&OsStr>,
    ) -> Option<Self> {
        let kind = match shell.file_name().and_then(OsStr::to_str)? {
            "zsh" => Shell::Zsh,
            "bash" => Shell::Bash,
            "fish" => Shell::Fish,
            "pwsh" | "pwsh-preview" => Shell::Pwsh,
            _ => return None,
        };
        let flag = match kind {
            Shell::Pwsh => "-Login",
            Shell::Zsh | Shell::Bash | Shell::Fish => "-l",
        };
        let login = match args {
            [] => false,
            [only] if only == flag => true,
            _ => return None,
        };
        let kubeconfig = kubeconfig.as_bytes();
        let startup = match kind {
            Shell::Zsh => Self {
                args: vec![if login { "-il" } else { "-i" }.into()],
                env: vec![("ZDOTDIR".into(), dir.into())],
                files: zsh(kubeconfig, dir, zdotdir),
            },
            Shell::Bash => {
                let script = dir.join(BASH);
                Self {
                    args: vec!["--init-file".into(), script.into()],
                    env: Vec::new(),
                    files: vec![(BASH, bash(kubeconfig, login))],
                }
            }
            Shell::Fish => {
                let line = [b"set -gx KUBECONFIG ", &Syntax::Fish.quote(kubeconfig)[..]].concat();
                let flags: &[&str] = if login {
                    &["-l", "--init-command"]
                } else {
                    &["--init-command"]
                };
                Self {
                    args: with_line(flags, line),
                    env: Vec::new(),
                    files: Vec::new(),
                }
            }
            Shell::Pwsh => {
                let line = [b"$env:KUBECONFIG = ", &Syntax::Pwsh.quote(kubeconfig)[..]].concat();
                // -Login only counts first, and a string -Command takes the rest.
                let flags: &[&str] = if login {
                    &["-Login", "-NoExit", "-Command"]
                } else {
                    &["-NoExit", "-Command"]
                };
                Self {
                    args: with_line(flags, line),
                    env: Vec::new(),
                    files: Vec::new(),
                }
            }
        };
        Some(startup)
    }
}

fn with_line(flags: &[&str], line: Vec<u8>) -> Vec<OsString> {
    flags
        .iter()
        .map(OsString::from)
        .chain([OsString::from_vec(line)])
        .collect()
}

/// Each of Twigo's files gives `ZDOTDIR` back to the person's, unset if it
/// was, sources theirs from there or `$HOME`, as zsh would
/// ([`sourcehome`]), and sets `KUBECONFIG`; then points `ZDOTDIR` at Twigo's
/// again where zsh reads another, remembering where the person's file left
/// theirs, as a `.zshenv` that sets it moves the rest.
///
/// [`sourcehome`]: https://github.com/zsh-users/zsh/blob/zsh-5.9/Src/init.c#L1531-L1553
fn zsh(kubeconfig: &[u8], dir: &Path, zdotdir: Option<&OsStr>) -> Vec<(&'static str, Vec<u8>)> {
    let posix = |word: &[u8]| Syntax::Posix.quote(word);
    let export = [b"builtin export KUBECONFIG=", &posix(kubeconfig)[..], b"\n"].concat();
    let ours = [b"ZDOTDIR=", &posix(dir.as_os_str().as_bytes())[..], b"\n"].concat();
    let theirs = match zdotdir {
        Some(zdotdir) => [b"_twigo_zdotdir=", &posix(zdotdir.as_bytes())[..], b"\n"].concat(),
        None => b"builtin unset _twigo_zdotdir\n".to_vec(),
    };
    // A global zshrc read while ZDOTDIR is Twigo's, as macOS's /etc/zshrc,
    // puts the history there.
    let history = [
        b"if [[ $HISTFILE == ",
        &posix(dir.join(".zsh_history").as_os_str().as_bytes())[..],
        b" ]]; then HISTFILE=\"${ZDOTDIR:-$HOME}/.zsh_history\"; fi\n",
    ]
    .concat();
    ZSH.iter()
        .map(|&(name, next)| {
            let mut file = Vec::new();
            if name == ".zshenv" {
                file.extend_from_slice(&theirs);
            }
            file.extend_from_slice(
                b"if (( ${+_twigo_zdotdir} )); then ZDOTDIR=\"$_twigo_zdotdir\"; else builtin unset ZDOTDIR; fi\n",
            );
            if name == ".zshrc" {
                file.extend_from_slice(&history);
            }
            file.extend_from_slice(
                format!(
                    "if [[ -r \"${{ZDOTDIR-$HOME}}/{name}\" ]]; then builtin . \"${{ZDOTDIR-$HOME}}/{name}\"; fi\n"
                )
                .as_bytes(),
            );
            file.extend_from_slice(&export);
            match next {
                Some(next) => {
                    file.extend_from_slice(format!("if [[ {next} ]]; then\n").as_bytes());
                    file.extend_from_slice(
                        b"  if (( ${+ZDOTDIR} )); then _twigo_zdotdir=\"$ZDOTDIR\"; else builtin unset _twigo_zdotdir; fi\n  ",
                    );
                    file.extend_from_slice(&ours);
                    file.extend_from_slice(b"else\n  builtin unset _twigo_zdotdir\nfi\n");
                }
                None => file.extend_from_slice(b"builtin unset _twigo_zdotdir\n"),
            }
            (name, file)
        })
        .collect()
}

/// What bash itself reads, then `KUBECONFIG`: as a login shell `/etc/profile`
/// and the first of `~/.bash_profile`, `~/.bash_login` and `~/.profile`
/// that exists, else `~/.bashrc` ([`execute_profile_file`]); bash reads its
/// system-wide bashrc, where it has one, before the init file
/// ([`execute_bashrc_file`]).
///
/// [`execute_profile_file`]: https://git.savannah.gnu.org/cgit/bash.git/tree/shell.c?h=bash-5.3#n1117
/// [`execute_bashrc_file`]: https://git.savannah.gnu.org/cgit/bash.git/tree/shell.c?h=bash-5.3#n1129
fn bash(kubeconfig: &[u8], login: bool) -> Vec<u8> {
    let read: &[u8] = if login {
        b"if [ -e /etc/profile ]; then builtin . /etc/profile; fi
if [ -e ~/.bash_profile ]; then builtin . ~/.bash_profile
elif [ -e ~/.bash_login ]; then builtin . ~/.bash_login
elif [ -e ~/.profile ]; then builtin . ~/.profile
fi
"
    } else {
        b"if [ -e ~/.bashrc ]; then builtin . ~/.bashrc; fi\n"
    };
    [
        read,
        b"builtin export KUBECONFIG=",
        &Syntax::Posix.quote(kubeconfig),
        b"\n",
    ]
    .concat()
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;

    const KUBECONFIG: &str = "/data/terminals/1/kubeconfig:/home/it's/.kube/config";

    fn of(shell: &str, args: &[&str]) -> Option<Startup> {
        let args: Vec<OsString> = args.iter().map(OsString::from).collect();
        Startup::of(
            Path::new(shell),
            &args,
            OsStr::new(KUBECONFIG),
            Path::new("/data/terminals/1"),
            None,
        )
    }

    fn args(startup: &Startup) -> Vec<&str> {
        startup
            .args
            .iter()
            .map(|arg| arg.to_str().expect("UTF-8"))
            .collect()
    }

    #[test]
    fn the_four_shells_run_twigo_s_line_after_their_own_files_with_the_value_quoted() {
        let zsh = of("/bin/zsh", &["-l"]).unwrap();
        assert_eq!(args(&zsh), ["-il"]);
        assert_eq!(
            zsh.env,
            [("ZDOTDIR".into(), PathBuf::from("/data/terminals/1").into())]
        );
        let names: Vec<&str> = zsh.files.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, [".zshenv", ".zprofile", ".zshrc", ".zlogin"]);
        assert_eq!(args(&of("/bin/zsh", &[]).unwrap()), ["-i"]);
        let bash = of("/bin/bash", &[]).unwrap();
        assert_eq!(args(&bash), ["--init-file", "/data/terminals/1/bashrc"]);
        let script = String::from_utf8(bash.files[0].1.clone()).unwrap();
        assert!(
            script.ends_with(
                "builtin export KUBECONFIG='/data/terminals/1/kubeconfig:/home/it'\\''s/.kube/config'\n"
            ),
            "{script}"
        );
        assert_eq!(
            args(&of("/opt/homebrew/bin/fish", &["-l"]).unwrap()),
            [
                "-l",
                "--init-command",
                r"set -gx KUBECONFIG '/data/terminals/1/kubeconfig:/home/it\'s/.kube/config'"
            ]
        );
        assert_eq!(
            args(&of("/usr/local/bin/pwsh", &["-Login"]).unwrap()),
            [
                "-Login",
                "-NoExit",
                "-Command",
                "$env:KUBECONFIG = '/data/terminals/1/kubeconfig:/home/it''s/.kube/config'"
            ]
        );
        assert_eq!(
            args(&of("/usr/bin/pwsh", &[]).unwrap())[..2],
            ["-NoExit", "-Command"]
        );
    }

    #[test]
    fn any_other_shell_or_arguments_get_nothing() {
        for shell in [
            "/bin/sh",
            "/bin/dash",
            "/bin/ksh",
            "/usr/bin/nu",
            "/usr/bin/xonsh",
        ] {
            assert_eq!(of(shell, &["-l"]), None, "{shell}");
        }
        assert_eq!(of("/bin/zsh", &["-c", "echo"]), None);
        assert_eq!(of("/usr/bin/pwsh", &["-l"]), None);
    }
}
