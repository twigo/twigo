//! bash and zsh, run live as login shells over a home of fixture startup
//! files, with a copy of this binary at a path that needs quoting standing
//! in for Twigo. It runs without the test harness, since it is also what
//! the shells run with `--dump-env`.

use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

const SHELL: &str = "TWIGO_TEST_LOGIN_SHELL";

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().collect();
    if let [_, flag, marker] = &args[..]
        && flag == twigo_env::DUMP_ENV
    {
        twigo_env::dump(marker).expect("print the environment");
        return ExitCode::SUCCESS;
    }
    match std::env::var_os(SHELL) {
        Some(shell) => resolve(Path::new(&shell)),
        None => run_each(),
    }
}

fn run_each() -> ExitCode {
    let mut failed = false;
    for name in ["bash", "zsh"] {
        let shell = on_path(name).unwrap_or_else(|| panic!("{name} is not on PATH"));
        let home = tempfile::tempdir().expect("a home");
        write_startup_files(home.path(), name);
        let exe = home.path().join(r"a b'c\d").join("twigo");
        std::fs::create_dir(exe.parent().expect("a parent")).expect("a directory");
        std::fs::copy(std::env::current_exe().expect("this binary"), &exe).expect("a copy");
        let status = Command::new(&exe)
            .env(SHELL, &shell)
            .env("HOME", home.path())
            .env_remove("ZDOTDIR")
            .status()
            .expect("run the copy");
        println!(
            "{} {name} ({})",
            if status.success() { "ok" } else { "FAILED" },
            shell.display()
        );
        failed |= !status.success();
    }
    if failed {
        ExitCode::FAILURE
    } else {
        ExitCode::SUCCESS
    }
}

fn write_startup_files(home: &Path, shell: &str) {
    let (login, interactive) = match shell {
        // bash reads only its profile as a login shell, so the profile sources .bashrc, as most do.
        "bash" => (".bash_profile", ".bashrc"),
        _ => (".zprofile", ".zshrc"),
    };
    let mut login_file = format!("export LOGIN_FILE={shell}\n");
    if shell == "bash" {
        login_file.push_str(". ~/.bashrc\n");
    }
    std::fs::write(home.join(login), login_file).expect("the login file");
    std::fs::write(
        home.join(interactive),
        format!("echo noise from {shell}\nexport RC_FILE={shell}\nexport MULTI='one\ntwo'\n"),
    )
    .expect("the interactive file");
}

fn resolve(shell: &Path) -> ExitCode {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("a runtime");
    let env = match runtime.block_on(twigo_env::resolve(shell)) {
        Ok(env) => env,
        Err(failure) => {
            eprintln!("{failure}\n{}", failure.output);
            return ExitCode::FAILURE;
        }
    };
    let name = shell.file_name().and_then(OsStr::to_str).expect("a name");
    let exe = std::env::current_exe().expect("this binary");
    let checks = [
        ("LOGIN_FILE", OsStr::new(name)),
        ("RC_FILE", OsStr::new(name)),
        ("MULTI", OsStr::new("one\ntwo")),
        // bash and zsh export `_` as the path of the command they run: this
        // copy, not the fallback's /usr/bin/env.
        ("_", exe.as_os_str()),
    ];
    let mut ok = true;
    for (var, expected) in checks {
        if env.get(var) != Some(expected) {
            eprintln!("{var} is {:?}, expected {expected:?}", env.get(var));
            ok = false;
        }
    }
    if ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn on_path(name: &str) -> Option<PathBuf> {
    std::env::split_paths(&std::env::var_os("PATH")?)
        .map(|dir| dir.join(name))
        .find(|path| path.is_file())
}
