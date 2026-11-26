//! What a person goes through before a command runs (ARCHITECTURE 6.4):
//! friction grows with what the command risks, and the context's mode and
//! type raise it.

use twigo_ipc::{ContextAccess, Environment, Friction, Mode, ModeSource};

/// How long a toast counts down before a pod its controller replaces is
/// deleted, as Headlamp holds it.
pub const COUNTDOWN_SECONDS: u32 = 5;

/// What a command risks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Risk {
    /// An undo puts it back: scale, cordon, suspend (ARCHITECTURE 6.4).
    Reversible,
    /// A pod that its controller replaces goes.
    Replaced,
    /// What it does stays: an object goes, pods are replaced, a Job runs.
    Lasting,
    /// It reaches everything an object holds, as deleting a namespace, a
    /// node or a CustomResourceDefinition does, or many objects at once;
    /// `name` is what the person types: the object's name, or for many the
    /// context's, as `guarded` asks.
    Wide { name: String },
    /// Secret-grade data shows (3.6).
    Reveal,
    /// The person has just read what it changes: an apply, whose diff 6.5
    /// shows before it runs.
    Reviewed,
    /// A shell or an attach, which a person opens often, so `guarded` asks
    /// in a dialog rather than for a typed name (6.4).
    Shell,
    /// A lasting change of the context's own protection: the context's
    /// access before and after it, as it is first, then under each set of
    /// the locks that may go taken away, the person's choices kept.
    Protection(Vec<(ContextAccess, ContextAccess)>),
    /// An unlock, which ends by itself and leaves every write in `guarded`
    /// asking for the context's name.
    Unlock,
}

/// The friction of `risk` on `context`. A `read-only` context blocks a
/// write before its friction matters, and asks the most of anything else.
pub fn friction(risk: &Risk, context: &str, access: &ContextAccess) -> Friction {
    let typed_context = || Friction::Typed {
        text: context.to_owned(),
    };
    match (risk, access.mode) {
        (Risk::Unlock, _) => Friction::Confirm,
        (Risk::Protection(_), _) if access.source == ModeSource::Unmarked => Friction::AtOnce,
        (Risk::Protection(views), _) if views.iter().all(|(from, to)| keeps(from, to)) => {
            Friction::AtOnce
        }
        (Risk::Protection(_), _) => typed_context(),
        (Risk::Reveal, Mode::ReadWrite) => Friction::AtOnce,
        (Risk::Reveal, Mode::Guarded | Mode::ReadOnly) => Friction::Confirm,
        (Risk::Reviewed, Mode::ReadWrite) => Friction::AtOnce,
        (Risk::Reviewed, Mode::Guarded | Mode::ReadOnly) => Friction::Confirm,
        (Risk::Shell, Mode::ReadWrite) => Friction::AtOnce,
        (Risk::Shell, Mode::Guarded | Mode::ReadOnly) => Friction::Confirm,
        (_, Mode::Guarded | Mode::ReadOnly) => typed_context(),
        (Risk::Reversible, Mode::ReadWrite) => Friction::AtOnce,
        (Risk::Replaced, Mode::ReadWrite)
            if access.environment != Some(Environment::Production) =>
        {
            Friction::Countdown {
                seconds: COUNTDOWN_SECONDS,
            }
        }
        (Risk::Replaced | Risk::Lasting, Mode::ReadWrite) => Friction::Confirm,
        (Risk::Wide { name }, Mode::ReadWrite) => Friction::Typed { text: name.clone() },
    }
}

/// Whether a change from `from` to `to` leaves the context at least as
/// strict as the mode it keeps. Leaving it unmarked weighs as `read-write`,
/// since any change from there runs at once, unless it was unmarked already;
/// a context unmarked before, which only a lock leaves unasked, counts as
/// its `guarded`.
pub fn keeps(from: &ContextAccess, to: &ContextAccess) -> bool {
    let unmarked = |access: &ContextAccess| access.source == ModeSource::Unmarked;
    let to = if unmarked(to) && !unmarked(from) {
        Mode::ReadWrite
    } else {
        to.mode
    };
    to >= lasting(from)
}

/// The mode a context keeps: an unlocked one relocks to `read-only`, which
/// a lasting change is weighed against.
fn lasting(access: &ContextAccess) -> Mode {
    if access.unlocked_until.is_some() {
        Mode::ReadOnly
    } else {
        access.mode
    }
}

/// Whether going through `planned` also meets `now`: what a plan's friction
/// was is enough while the mode asks no more, and a typed name holds only
/// for the same name.
pub fn covers(planned: &Friction, now: &Friction) -> bool {
    fn rank(friction: &Friction) -> u8 {
        match friction {
            Friction::AtOnce => 0,
            Friction::Countdown { .. } => 1,
            Friction::Confirm => 2,
            Friction::Typed { .. } => 3,
        }
    }
    planned == now || rank(planned) > rank(now)
}

#[cfg(test)]
mod tests {
    use twigo_ipc::ModeSource;

    use super::*;

    fn access(mode: Mode, environment: Option<Environment>) -> ContextAccess {
        ContextAccess {
            mode,
            source: ModeSource::User { overrides: None },
            environment,
            unlocked_until: None,
        }
    }

    #[test]
    fn friction_grows_with_the_risk_and_the_mode_raises_it() {
        let wide = Risk::Wide {
            name: "payments".to_owned(),
        };
        let typed = |text: &str| Friction::Typed {
            text: text.to_owned(),
        };
        let countdown = Friction::Countdown { seconds: 5 };
        let production = Some(Environment::Production);
        let staging = Some(Environment::Staging);
        let cases = [
            (Risk::Replaced, Mode::ReadWrite, None, countdown.clone()),
            (Risk::Replaced, Mode::ReadWrite, staging, countdown),
            (
                Risk::Replaced,
                Mode::ReadWrite,
                production,
                Friction::Confirm,
            ),
            (Risk::Lasting, Mode::ReadWrite, None, Friction::Confirm),
            (Risk::Reversible, Mode::ReadWrite, None, Friction::AtOnce),
            (
                Risk::Reversible,
                Mode::ReadWrite,
                production,
                Friction::AtOnce,
            ),
            (Risk::Reversible, Mode::Guarded, None, typed("kind-a")),
            (wide.clone(), Mode::ReadWrite, None, typed("payments")),
            (wide.clone(), Mode::ReadWrite, production, typed("payments")),
            (Risk::Replaced, Mode::Guarded, None, typed("kind-a")),
            (Risk::Lasting, Mode::Guarded, None, typed("kind-a")),
            (wide.clone(), Mode::Guarded, None, typed("kind-a")),
            (wide, Mode::ReadOnly, production, typed("kind-a")),
            (Risk::Reveal, Mode::ReadWrite, production, Friction::AtOnce),
            (Risk::Reveal, Mode::Guarded, None, Friction::Confirm),
            (Risk::Reveal, Mode::ReadOnly, None, Friction::Confirm),
            (Risk::Reviewed, Mode::ReadWrite, None, Friction::AtOnce),
            (
                Risk::Reviewed,
                Mode::ReadWrite,
                production,
                Friction::AtOnce,
            ),
            (Risk::Reviewed, Mode::Guarded, None, Friction::Confirm),
            (
                Risk::Reviewed,
                Mode::ReadOnly,
                production,
                Friction::Confirm,
            ),
            (Risk::Shell, Mode::ReadWrite, None, Friction::AtOnce),
            (Risk::Shell, Mode::ReadWrite, production, Friction::AtOnce),
            (Risk::Shell, Mode::Guarded, staging, Friction::Confirm),
            (Risk::Shell, Mode::ReadOnly, production, Friction::Confirm),
        ];
        for (risk, mode, environment, expected) in cases {
            assert_eq!(
                friction(&risk, "kind-a", &access(mode, environment)),
                expected,
                "{risk:?} in {mode:?} {environment:?}"
            );
        }
    }

    #[test]
    fn lowering_protection_asks_for_the_name_and_an_unlock_in_a_dialog() {
        let typed = Friction::Typed {
            text: "kind-a".to_owned(),
        };
        let marked = |mode| access(mode, None);
        let unmarked = ContextAccess {
            source: ModeSource::Unmarked,
            ..marked(Mode::Guarded)
        };
        let unlocked = ContextAccess {
            unlocked_until: Some(1),
            ..access(Mode::Guarded, Some(Environment::Production))
        };
        let (read_write, guarded, read_only) = (
            marked(Mode::ReadWrite),
            marked(Mode::Guarded),
            marked(Mode::ReadOnly),
        );
        let cases = [
            (&read_only, &read_write, typed.clone()),
            (&read_only, &guarded, typed.clone()),
            (&guarded, &read_write, typed.clone()),
            (&read_write, &read_only, Friction::AtOnce),
            (&read_write, &guarded, Friction::AtOnce),
            (&guarded, &guarded, Friction::AtOnce),
            (&read_only, &read_only, Friction::AtOnce),
            (&unmarked, &read_write, Friction::AtOnce),
            (&unmarked, &read_only, Friction::AtOnce),
            (&read_only, &unmarked, typed.clone()),
            (&guarded, &unmarked, typed.clone()),
            (&unlocked, &unmarked, typed.clone()),
            (&read_write, &unmarked, Friction::AtOnce),
            (&unmarked, &unmarked, Friction::AtOnce),
            (&unlocked, &guarded, typed.clone()),
            (&unlocked, &read_only, Friction::AtOnce),
        ];
        for (before, after, expected) in cases {
            let risk = Risk::Protection(vec![(before.clone(), after.clone())]);
            assert_eq!(
                friction(&risk, "kind-a", before),
                expected,
                "from {before:?} to {after:?}"
            );
        }
        for before in [read_only, unlocked] {
            let unlock = friction(&Risk::Unlock, "kind-a", &before);
            assert_eq!(unlock, Friction::Confirm, "{before:?}");
        }
    }

    #[test]
    fn a_change_asks_for_the_name_where_it_lowers_the_context_under_any_set_of_locks_gone() {
        let typed = Friction::Typed {
            text: "kind-a".to_owned(),
        };
        let locked = ContextAccess {
            source: ModeSource::Kubeconfig,
            ..access(Mode::ReadOnly, None)
        };
        let typed_as = |mode, environment| ContextAccess {
            source: ModeSource::Environment { environment },
            ..access(mode, Some(environment))
        };
        let unmarked = ContextAccess {
            source: ModeSource::Unmarked,
            ..access(Mode::Guarded, None)
        };
        let (development, staging, production) = (
            typed_as(Mode::ReadWrite, Environment::Development),
            typed_as(Mode::Guarded, Environment::Staging),
            typed_as(Mode::ReadOnly, Environment::Production),
        );
        let held = (locked.clone(), locked.clone());
        let cases = [
            (&unmarked, &development, typed.clone()),
            (&unmarked, &staging, Friction::AtOnce),
            (&unmarked, &production, Friction::AtOnce),
            (&unmarked, &unmarked, Friction::AtOnce),
            (&staging, &production, Friction::AtOnce),
        ];
        for (before, after, expected) in cases {
            let risk = Risk::Protection(vec![held.clone(), (before.clone(), after.clone())]);
            assert_eq!(
                friction(&risk, "kind-a", &locked),
                expected,
                "from {before:?} to {after:?} beneath the lock"
            );
        }
        let guarded = access(Mode::Guarded, None);
        let lowered = Risk::Protection(vec![
            (locked.clone(), guarded.clone()),
            (unmarked.clone(), guarded),
        ]);
        assert_eq!(friction(&lowered, "kind-a", &locked), typed);
        let between = Risk::Protection(vec![
            held,
            (production, staging.clone()),
            (unmarked, staging),
        ]);
        assert_eq!(friction(&between, "kind-a", &locked), typed);
    }

    #[test]
    fn a_plan_covers_the_mode_only_while_it_asks_no_more() {
        let typed = |text: &str| Friction::Typed {
            text: text.to_owned(),
        };
        let countdown = Friction::Countdown { seconds: 5 };
        assert!(covers(&Friction::Confirm, &Friction::Confirm));
        assert!(covers(&Friction::Confirm, &countdown));
        assert!(covers(&typed("kind-a"), &Friction::Confirm));
        assert!(covers(&countdown, &Friction::AtOnce));
        assert!(!covers(&Friction::Confirm, &typed("kind-a")));
        assert!(!covers(&countdown, &Friction::Confirm));
        assert!(!covers(&Friction::AtOnce, &countdown));
        assert!(!covers(&typed("payments"), &typed("kind-a")));
    }
}
