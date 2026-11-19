//! Changes of a context's own protection (ARCHITECTURE 6.4): the person's
//! mode, the type they mark it as, and an unlock. They send nothing to a
//! cluster, so a plan has no writes and no kubectl command, and it runs only
//! while the context stands as it was planned.

use twigo_ipc::{Environment, IpcError, LockSource, Mode, ModeSource};
use twigo_policy::friction::Risk;
use twigo_policy::{Change, PlannedChange, UNLOCK};

use crate::bus::{self, Planned};
use crate::{Core, errors};

pub(crate) async fn protection(
    core: &Core,
    context: String,
    change: Change,
) -> Result<Planned, IpcError> {
    core.listed(&context).await?;
    let planned = core
        .policy
        .plan(&context, change)
        .map_err(|error| errors::refused(&error))?;
    let Words {
        question,
        confirm,
        doing,
        done,
    } = words(&context, &planned);
    Ok(Planned {
        connection: core.policy.connection(&context),
        space: None,
        risk: match change {
            Change::Unlock => Risk::Unlock,
            Change::Mode { .. } | Change::Type { .. } => Risk::Protection {
                mode: (planned.after.source != ModeSource::Unmarked).then_some(planned.after.mode),
            },
        },
        writes: Vec::new(),
        command: match change {
            Change::Mode { .. } => "mode",
            Change::Type { .. } => "type",
            Change::Unlock => "unlock",
        },
        target: context.clone(),
        question,
        confirm,
        destructive: false,
        consequences: consequences(&context, &planned),
        affected: Vec::new(),
        kubectl: None,
        doing,
        previewed: None,
        run: bus::Run::Protects {
            change: planned,
            done,
        },
        context,
    })
}

struct Words {
    question: String,
    confirm: String,
    doing: String,
    done: String,
}

fn words(context: &str, planned: &PlannedChange) -> Words {
    let mode = planned.after.mode.name();
    let minutes = UNLOCK.as_mins();
    match planned.change {
        Change::Mode { mode: Some(_) } => Words {
            question: format!("Make {context} {mode}?"),
            confirm: format!("Make {mode}"),
            doing: format!("Making {context} {mode}"),
            done: format!("Made {context} {mode}"),
        },
        Change::Mode { mode: None } => Words {
            question: format!(
                "Make {context} {mode}{}, in place of your mode?",
                why(&planned.after.source)
            ),
            confirm: format!("Make {mode}"),
            doing: format!("Making {context} {mode}"),
            done: format!("Made {context} {mode}"),
        },
        Change::Type {
            environment: Some(environment),
        } => {
            let environment = name(environment);
            Words {
                question: format!("Mark {context} as {environment}?"),
                confirm: format!("Mark as {environment}"),
                doing: format!("Marking {context} as {environment}"),
                done: format!("Marked {context} as {environment}"),
            }
        }
        Change::Type { environment: None } => Words {
            question: format!("Clear the type of {context}, whatever its kubeconfig says?"),
            confirm: "Clear type".to_owned(),
            doing: format!("Clearing the type of {context}"),
            done: format!("Cleared the type of {context}"),
        },
        Change::Unlock => Words {
            question: format!("Unlock {context} for {minutes} minutes?"),
            confirm: format!("Unlock for {minutes} minutes"),
            doing: format!("Unlocking {context}"),
            done: format!("Unlocked {context} for {minutes} minutes"),
        },
    }
}

/// What the change does to what is asked: what stops being asked or
/// refused, or starts to be, a lock the person's mode sets aside, and the
/// end of an unlock.
fn consequences(context: &str, planned: &PlannedChange) -> Vec<String> {
    let PlannedChange { before, after, .. } = planned;
    let unlock = planned.change == Change::Unlock;
    let was = if before.source == ModeSource::Unmarked {
        None
    } else if before.unlocked_until.is_some() {
        Some(Mode::ReadOnly)
    } else {
        Some(before.mode)
    };
    let mut said = Vec::new();
    if after.source == ModeSource::Unmarked {
        said.push(format!(
            "Its first write or exec asks what {context} is, and nothing is sent until you say."
        ));
    } else if was == Some(after.mode) && !unlock {
        said.push(format!(
            "It stays {}{}.",
            after.mode.name(),
            why(&after.source)
        ));
    } else {
        said.extend(asks(context, after.mode, was));
    }
    if let ModeSource::User {
        overrides: Some(lock),
    } = &after.source
    {
        said.push(format!(
            "It sets aside the {} {}.",
            lock.mode.name(),
            locked_by(&lock.source)
        ));
    }
    if unlock {
        said.push(format!(
            "It relocks by itself in {} minutes.",
            UNLOCK.as_mins()
        ));
    } else if before.unlocked_until.is_some() {
        said.push("Its unlock ends.".to_owned());
    }
    said
}

/// What `mode` asks of the person and of processes, said as what changes
/// from `was`, none for a context nobody had marked, whose writes and execs
/// were refused, a process's asking what it is.
fn asks(context: &str, mode: Mode, was: Option<Mode>) -> Vec<String> {
    const OPENED: &str = "Writes and shells are no longer refused";
    let refused = matches!(was, None | Some(Mode::ReadOnly));
    let unmarked = was.is_none();
    match mode {
        Mode::ReadWrite => {
            let opened = if refused {
                OPENED.to_owned()
            } else {
                format!("Writes stop asking for {context}'s name")
            };
            vec![
                format!(
                    "{opened}: a scale, an apply or a shell runs at once, and a delete asks in a dialog."
                ),
                "Processes in its terminals write and exec without asking, and new terminals use your own kubeconfig.".to_owned(),
            ]
        }
        Mode::Guarded => {
            let asks = format!(
                "write asks for {context}'s name typed, and a shell or an apply asks in a dialog."
            );
            let processes = if unmarked {
                format!(
                    "A process's write or exec in its terminals asks you to allow it, rather than what {context} is."
                )
            } else {
                "A process's write or exec in its terminals waits for your answer.".to_owned()
            };
            vec![
                if refused {
                    format!("{OPENED}: each {asks}")
                } else {
                    format!("Each {asks}")
                },
                processes,
            ]
        }
        Mode::ReadOnly if unmarked => vec![
            "Every write, exec and shell stays refused; reads, dry runs and port-forwards go on."
                .to_owned(),
            format!(
                "A process's write or exec in its terminals is refused, rather than asking what {context} is."
            ),
        ],
        Mode::ReadOnly => vec![
            "Every write, exec and shell is refused; reads, dry runs and port-forwards go on."
                .to_owned(),
        ],
    }
}

/// Why a context has its mode, after the mode in a sentence.
fn why(source: &ModeSource) -> String {
    match source {
        ModeSource::User { .. } => " by your choice".to_owned(),
        ModeSource::Kubeconfig => " as its kubeconfig says".to_owned(),
        ModeSource::Provider => " as its provider says".to_owned(),
        ModeSource::Environment { environment } => {
            format!(" as {} by default", name(*environment))
        }
        ModeSource::Unmarked => " until you say what it is".to_owned(),
        ModeSource::PolicyFile {
            file,
            pattern: Some(pattern),
        } => format!(" by {pattern} in {file}"),
        ModeSource::PolicyFile {
            file,
            pattern: None,
        } => format!(" because {file} cannot be read"),
        ModeSource::Unlisted | ModeSource::Moved => String::new(),
    }
}

fn locked_by(source: &LockSource) -> String {
    match source {
        LockSource::Kubeconfig => "its kubeconfig sets".to_owned(),
        LockSource::Provider => "its provider sets".to_owned(),
        LockSource::Environment { environment } => {
            format!("{} sets by default", name(*environment))
        }
    }
}

fn name(environment: Environment) -> &'static str {
    match environment {
        Environment::Production => "Production",
        Environment::Staging => "Staging",
        Environment::Development => "Development",
        Environment::Local => "Local",
    }
}

#[cfg(test)]
mod tests {
    use twigo_ipc::{ContextAccess, Lock};

    use super::*;

    fn access(mode: Mode, source: ModeSource) -> ContextAccess {
        ContextAccess {
            mode,
            source,
            environment: None,
            unlocked_until: None,
        }
    }

    fn planned(change: Change, before: ContextAccess, after: ContextAccess) -> PlannedChange {
        let policy = twigo_policy::Policy::open();
        policy.set_mode("kind-a", Some(Mode::ReadOnly)).unwrap();
        let mut planned = policy.plan("kind-a", change).unwrap();
        planned.before = before;
        planned.after = after;
        planned
    }

    #[test]
    fn a_change_says_what_stops_being_asked_and_the_lock_it_sets_aside() {
        let production = ModeSource::Environment {
            environment: Environment::Production,
        };
        let overrides = ModeSource::User {
            overrides: Some(Lock {
                mode: Mode::ReadOnly,
                source: LockSource::Environment {
                    environment: Environment::Production,
                },
            }),
        };
        let lowered = planned(
            Change::Mode {
                mode: Some(Mode::ReadWrite),
            },
            access(Mode::ReadOnly, production),
            access(Mode::ReadWrite, overrides),
        );
        let said = words("prod-eu", &lowered);
        assert_eq!(said.question, "Make prod-eu read-write?");
        assert_eq!(said.confirm, "Make read-write");
        assert_eq!(said.done, "Made prod-eu read-write");
        assert_eq!(
            consequences("prod-eu", &lowered),
            [
                "Writes and shells are no longer refused: a scale, an apply or a shell runs at once, and a delete asks in a dialog.",
                "Processes in its terminals write and exec without asking, and new terminals use your own kubeconfig.",
                "It sets aside the read-only Production sets by default.",
            ]
        );
    }

    #[test]
    fn an_unlock_says_what_it_lets_through_and_when_it_ends() {
        let user = ModeSource::User { overrides: None };
        let unlock = planned(
            Change::Unlock,
            access(Mode::ReadOnly, user.clone()),
            ContextAccess {
                unlocked_until: Some(1),
                ..access(Mode::Guarded, user)
            },
        );
        let said = words("prod-eu", &unlock);
        assert_eq!(said.question, "Unlock prod-eu for 15 minutes?");
        assert_eq!(said.confirm, "Unlock for 15 minutes");
        assert_eq!(
            consequences("prod-eu", &unlock),
            [
                "Writes and shells are no longer refused: each write asks for prod-eu's name typed, and a shell or an apply asks in a dialog.",
                "A process's write or exec in its terminals waits for your answer.",
                "It relocks by itself in 15 minutes.",
            ]
        );
    }

    #[test]
    fn clearing_the_last_mark_says_the_first_write_asks() {
        let cleared = planned(
            Change::Type { environment: None },
            access(
                Mode::ReadWrite,
                ModeSource::Environment {
                    environment: Environment::Development,
                },
            ),
            access(Mode::Guarded, ModeSource::Unmarked),
        );
        assert_eq!(
            words("kind-a", &cleared).question,
            "Clear the type of kind-a, whatever its kubeconfig says?"
        );
        assert_eq!(
            consequences("kind-a", &cleared),
            ["Its first write or exec asks what kind-a is, and nothing is sent until you say."]
        );
    }

    #[test]
    fn marking_an_unmarked_context_says_its_refused_writes_now_run_ask_or_stay_refused() {
        let marked = |environment, mode| {
            planned(
                Change::Type {
                    environment: Some(environment),
                },
                access(Mode::Guarded, ModeSource::Unmarked),
                access(mode, ModeSource::Environment { environment }),
            )
        };
        let staging = marked(Environment::Staging, Mode::Guarded);
        assert_eq!(
            words("kind-a", &staging).question,
            "Mark kind-a as Staging?"
        );
        let cases = [
            (
                marked(Environment::Development, Mode::ReadWrite),
                [
                    "Writes and shells are no longer refused: a scale, an apply or a shell runs at once, and a delete asks in a dialog.",
                    "Processes in its terminals write and exec without asking, and new terminals use your own kubeconfig.",
                ],
            ),
            (
                staging,
                [
                    "Writes and shells are no longer refused: each write asks for kind-a's name typed, and a shell or an apply asks in a dialog.",
                    "A process's write or exec in its terminals asks you to allow it, rather than what kind-a is.",
                ],
            ),
            (
                marked(Environment::Production, Mode::ReadOnly),
                [
                    "Every write, exec and shell stays refused; reads, dry runs and port-forwards go on.",
                    "A process's write or exec in its terminals is refused, rather than asking what kind-a is.",
                ],
            ),
        ];
        for (planned, said) in cases {
            assert_eq!(
                consequences("kind-a", &planned),
                said,
                "{:?}",
                planned.after
            );
        }
    }
}
