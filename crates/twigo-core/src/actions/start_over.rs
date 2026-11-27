//! Starting over from the person's protection file that cannot be read
//! (ARCHITECTURE 4.8, 6.4): the file moves aside, and the person's modes and
//! types go with it. It acts on no context and sends nothing to a cluster,
//! so its plan has no context, no writes and no kubectl command.

use twigo_ipc::IpcError;
use twigo_policy::{Entry, Refused, StartOver, Why};

use crate::bus::{Acts, Planned};
use crate::{Core, errors};

/// As the audit log names the command.
const COMMAND: &str = "startOver";

pub(crate) fn start_over(core: &Core) -> Result<Planned, IpcError> {
    let StartOver {
        file,
        aside,
        reason,
    } = core
        .policy
        .plan_start_over()
        .map_err(|error| start_over_refused(core, &error))?;
    Ok(Planned {
        acts: Acts::StartsOver {
            done: "Started over without the modes and types you set".to_owned(),
        },
        command: COMMAND,
        question: "Start over without the modes and types you set?".to_owned(),
        confirm: "Start Over".to_owned(),
        destructive: false,
        consequences: vec![
            format!(
                "It moves {file}, which cannot be read ({reason}), to {aside}, in place of any file there."
            ),
            "Every context you marked before asks again: one that an admin's policy file, its kubeconfig or its provider locks keeps that lock, and any other asks what it is before its first write or exec.".to_owned(),
        ],
        affected: Vec::new(),
        command_line: None,
        doing: "Starting over".to_owned(),
        target: file,
    })
}

/// What the webview is told of a start over the policy refused, once the
/// audit log has it.
pub(crate) fn start_over_refused(core: &Core, error: &Refused) -> IpcError {
    core.policy.audit().record(&Entry::Refused {
        on: None,
        command: COMMAND,
        target: &core.policy.protection_file(),
        why: Why::from(error),
    });
    errors::refused(error)
}
