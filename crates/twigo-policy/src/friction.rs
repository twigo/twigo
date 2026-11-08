//! What a person goes through before a command runs (ARCHITECTURE 6.4):
//! friction grows with what the command risks, and the context's mode and
//! type raise it.

use twigo_ipc::{ContextAccess, Environment, Friction, Mode};

/// How long a toast counts down before a pod its controller replaces is
/// deleted, as Headlamp holds it.
pub const COUNTDOWN_SECONDS: u32 = 5;

/// What a command risks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Risk {
    /// An undo puts it back: scale, cordon, suspend (decision 1 of M2).
    Reversible,
    /// A pod that its controller replaces goes.
    Replaced,
    /// What it does stays: an object goes, pods are replaced, a Job runs.
    Lasting,
    /// It reaches everything an object holds, as deleting a namespace, a
    /// node or a CustomResourceDefinition does, or many objects at once;
    /// `name` is what the person types.
    Wide { name: String },
    /// Secret-grade data shows (3.6).
    Reveal,
}

/// The friction of `risk` on `context`. A `read-only` context blocks a
/// write before its friction matters, and asks the most of anything else.
pub fn friction(risk: &Risk, context: &str, access: &ContextAccess) -> Friction {
    let typed_context = || Friction::Typed {
        text: context.to_owned(),
    };
    match (risk, access.mode) {
        (Risk::Reveal, Mode::ReadWrite) => Friction::AtOnce,
        (Risk::Reveal, Mode::Guarded | Mode::ReadOnly) => Friction::Confirm,
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
            source: ModeSource::Default,
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
