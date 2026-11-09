//! How a session ended, from the status the server sent: the status's text
//! only chooses the words, the decision rests on whether anything printed
//! and on its code.

use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use twigo_ipc::{ErrorKind, IpcError, ShellEnd};

/// `shell` says it ran our command rather than joined a container's main
/// process.
pub(super) fn ending(status: Option<&Status>, printed: bool, shell: bool) -> ShellEnd {
    let Some(status) = status else {
        return ShellEnd::ConnectionLost;
    };
    if status.status.as_deref() == Some("Success") {
        return if shell {
            ShellEnd::Exited { code: 0 }
        } else {
            ShellEnd::Detached
        };
    }
    let message = status.message.clone().unwrap_or_default();
    if let Some(code) = exit_code(status) {
        if shell && !printed && matches!(code, 126 | 127) {
            return ShellEnd::NoShell { message };
        }
        return ShellEnd::Exited { code };
    }
    if printed {
        return ShellEnd::ConnectionLost;
    }
    if shell && no_executable(&message) {
        return ShellEnd::NoShell { message };
    }
    ShellEnd::Failed {
        error: IpcError::new(ErrorKind::Unavailable, message),
    }
}

fn exit_code(status: &Status) -> Option<i32> {
    if status.reason.as_deref() != Some("NonZeroExitCode") {
        return None;
    }
    status
        .details
        .as_ref()?
        .causes
        .as_ref()?
        .iter()
        .find(|cause| cause.reason.as_deref() == Some("ExitCode"))?
        .message
        .as_deref()?
        .parse()
        .ok()
}

/// What a runtime says of a shell the container does not have.
fn no_executable(message: &str) -> bool {
    message.contains("executable file not found") || message.contains("no such file or directory")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn status(json: &str) -> Status {
        serde_json::from_str(json).unwrap()
    }

    const SUCCESS: &str = r#"{"status":"Success"}"#;
    const EXIT_3: &str = r#"{"status":"Failure","reason":"NonZeroExitCode","details":{"causes":[{"reason":"ExitCode","message":"3"}]}}"#;
    const EXIT_127: &str = r#"{"status":"Failure","reason":"NonZeroExitCode","message":"command terminated with non-zero exit code","details":{"causes":[{"reason":"ExitCode","message":"127"}]}}"#;
    const EXIT_126: &str = r#"{"status":"Failure","reason":"NonZeroExitCode","message":"command terminated with non-zero exit code","details":{"causes":[{"reason":"ExitCode","message":"126"}]}}"#;
    const NO_SHELL: &str = r#"{"status":"Failure","reason":"InternalError","code":500,"message":"Internal error occurred: Internal error occurred: failed to exec in container: failed to start exec \"b\": OCI runtime exec failed: exec failed: unable to start container process: exec: \"bash\": executable file not found in $PATH"}"#;
    const NOT_EXECUTABLE: &str = r#"{"status":"Failure","reason":"InternalError","code":500,"message":"Internal error occurred: failed to exec: exec: \"/etc/passwd\": permission denied"}"#;
    const NO_FILE: &str = r#"{"status":"Failure","reason":"InternalError","code":500,"message":"Internal error occurred: stat /bin/sh: no such file or directory"}"#;

    fn no_shell(json: &str) -> ShellEnd {
        ShellEnd::NoShell {
            message: status(json).message.unwrap(),
        }
    }

    fn failed(json: &str) -> ShellEnd {
        ShellEnd::Failed {
            error: IpcError::new(ErrorKind::Unavailable, status(json).message.unwrap()),
        }
    }

    #[test]
    fn each_status_ends_the_session_as_the_table_says() {
        let cases = [
            (
                "success",
                SUCCESS,
                false,
                true,
                ShellEnd::Exited { code: 0 },
            ),
            (
                "success of an attach",
                SUCCESS,
                true,
                false,
                ShellEnd::Detached,
            ),
            ("exit 3", EXIT_3, false, true, ShellEnd::Exited { code: 3 }),
            (
                "exit 3 after output",
                EXIT_3,
                true,
                true,
                ShellEnd::Exited { code: 3 },
            ),
            ("127 unprinted", EXIT_127, false, true, no_shell(EXIT_127)),
            ("126 unprinted", EXIT_126, false, true, no_shell(EXIT_126)),
            (
                "127 after output is the person's exit",
                EXIT_127,
                true,
                true,
                ShellEnd::Exited { code: 127 },
            ),
            (
                "127 of an attach",
                EXIT_127,
                false,
                false,
                ShellEnd::Exited { code: 127 },
            ),
            ("not found", NO_SHELL, false, true, no_shell(NO_SHELL)),
            ("no such file", NO_FILE, false, true, no_shell(NO_FILE)),
            (
                "permission denied is no missing shell",
                NOT_EXECUTABLE,
                false,
                true,
                failed(NOT_EXECUTABLE),
            ),
            (
                "a stream failure after output",
                NO_SHELL,
                true,
                true,
                ShellEnd::ConnectionLost,
            ),
            (
                "a stream failure after output of an attach",
                NO_SHELL,
                true,
                false,
                ShellEnd::ConnectionLost,
            ),
            (
                "not found on attach",
                NO_SHELL,
                false,
                false,
                failed(NO_SHELL),
            ),
        ];
        for (what, json, printed, shell, expected) in cases {
            assert_eq!(
                ending(Some(&status(json)), printed, shell),
                expected,
                "{what}"
            );
        }
    }

    #[test]
    fn no_status_at_all_is_a_lost_connection_never_a_failed_shell() {
        assert_eq!(ending(None, false, true), ShellEnd::ConnectionLost);
        assert_eq!(ending(None, true, false), ShellEnd::ConnectionLost);
    }
}
