//! The approval broker (ARCHITECTURE 6.4): a process's write or exec through
//! the policy proxy in a `guarded` context waits while the window its token
//! names asks the person, and goes on with the approval they gave, which the
//! gate in the actor's clients reads. Terminals get "once" and "for 15
//! minutes"; every delete asks, with the context's name typed. A window that
//! follows no asks, or a process with none, is denied at once.

pub(crate) mod detail;

use std::collections::{BTreeMap, HashMap};
use std::future::Future;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use jiff::{SignedDuration, Timestamp};
use tokio::sync::{oneshot, watch};
use twigo_ipc::{
    AnswerApproval, ApprovalAnswer, ApprovalAsk, ApprovalDetail, ApprovalEvent, ApprovalId,
    BlockReason, Blocked, ErrorKind, IpcError, Mode, ModeSource,
};
use twigo_policy::{Approval, Attributes, Entry, Policy};

use crate::catalog::Contexts;
use crate::proxy::{Changes, Digest, Holder};

/// How long an answer of "lasting" holds.
const LASTING: SignedDuration = SignedDuration::from_mins(15);
/// How long one answer covers a request's repeats: kubectl repeats a refused
/// upgrade over SPDY after WebSocket, and a write after each `429`, for up
/// to about 10 s ([`checkWait`](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/client-go/rest/with_retry.go#L309-L318)).
const REPEATS: Duration = Duration::from_secs(15);

pub(crate) struct Approvals {
    policy: Arc<Policy>,
    catalog: watch::Receiver<Option<Arc<Contexts>>>,
    state: Mutex<State>,
    served: detail::Served,
}

#[derive(Default)]
struct State {
    /// One per window: a later follower replaces the earlier.
    followers: HashMap<Arc<str>, Follower>,
    asks: BTreeMap<u32, Pending>,
    /// By process and context.
    grants: HashMap<(u64, String), Grant>,
    repeats: HashMap<Digest, Repeat>,
    next: u32,
}

type Follower = Box<dyn FnMut(ApprovalEvent) -> bool + Send>;

struct Pending {
    window: Arc<str>,
    ask: ApprovalAsk,
    resolve: oneshot::Sender<Resolution>,
}

enum Resolution {
    Answered(ApprovalAnswer),
    /// The window that would answer went.
    Nobody,
}

/// "For 15 minutes", which holds only while the context's mode, where it
/// comes from and its connection stay what they were: a change that went
/// back again ends it too.
struct Grant {
    until: Timestamp,
    mode: Mode,
    source: ModeSource,
    connection: u64,
    /// [`Policy::changes_of`] the context when it was given.
    changes: u64,
}

struct Repeat {
    until: Instant,
    cover: Cover,
}

enum Cover {
    /// Every repeat, in these words.
    Denied(String),
    /// Repeats while none of them has reached the server: one after a `429`,
    /// or after an upgrade answered other than `101`.
    Once,
}

/// A request the gate would stop for want of an approval.
pub(crate) struct Asking<'a> {
    pub holder: &'a Holder,
    pub attributes: &'a Attributes,
    /// The gate's words for it, should no window ask.
    pub blocked: Box<Blocked>,
    pub repeat: Digest,
    /// The client's `Kubectl-Command`: a label, never checked.
    pub command: Option<String>,
    pub impersonate: Option<String>,
}

pub(crate) enum Outcome {
    /// Send it with `approval`, and tell [`Approvals::reached`] of `repeat`
    /// once it reaches the server.
    Approved {
        approval: Approval,
        repeat: Option<Digest>,
    },
    /// Not sent, in these words.
    Denied(String),
    /// The context's access changed while it waited, so that it needs no
    /// approval any more: what the gate says of it now.
    Decided(Result<(), Box<Blocked>>),
    /// The context names another cluster now.
    Moved,
    /// The process's handle dropped.
    Ended,
}

impl Approvals {
    pub(crate) fn new(
        policy: Arc<Policy>,
        catalog: watch::Receiver<Option<Arc<Contexts>>>,
    ) -> Self {
        Self {
            policy,
            catalog,
            state: Mutex::default(),
            served: detail::Served::default(),
        }
    }

    /// Asks the person, unless an answer or a grant covers the request
    /// already; `detail` is awaited only when an ask goes out.
    pub(crate) async fn decide(
        &self,
        asking: Asking<'_>,
        detail: impl Future<Output = ApprovalDetail>,
    ) -> Outcome {
        let Asking {
            holder, attributes, ..
        } = &asking;
        let context = holder.context.as_str();
        let delete = is_delete(attributes);
        // Before the detail's dry run, which a change may outlast.
        let changes = Changes::new(&self.policy, &self.catalog);
        {
            let mut state = self.state();
            let now = Instant::now();
            state.repeats.retain(|_, repeat| repeat.until > now);
            match state
                .repeats
                .get(&asking.repeat)
                .map(|repeat| &repeat.cover)
            {
                Some(Cover::Denied(message)) => return Outcome::Denied(message.clone()),
                Some(Cover::Once) => {
                    return Outcome::Approved {
                        approval: Approval::once(context, holder.actor, attributes),
                        repeat: Some(asking.repeat),
                    };
                }
                None => {}
            }
            let grant = state.grants.get(&(holder.process, context.to_owned()));
            if !delete
                && let Some(grant) = grant
                && self.holds(context, grant)
            {
                return Outcome::Approved {
                    approval: Approval::until(context, holder.actor, grant.until),
                    repeat: None,
                };
            }
        }
        let Some(window) = holder.window.clone() else {
            return self.nobody(&asking);
        };
        if !self.state().followers.contains_key(&window) {
            return self.nobody(&asking);
        }
        let detail = detail.await;
        let (resolve, resolved) = oneshot::channel();
        let id = {
            let mut state = self.state();
            let id = state.next;
            state.next = state.next.wrapping_add(1);
            let ask = ApprovalAsk {
                id: ApprovalId(id),
                context: context.to_owned(),
                process: holder.label.to_string(),
                command: asking.command.clone(),
                verb: verb(attributes),
                class: attributes.class,
                target: attributes.target(),
                impersonate: asking.impersonate.clone(),
                detail,
                typed: delete,
                lasting_minutes: (!delete).then_some(LASTING.as_mins() as u32),
            };
            let told = state.followers.get_mut(&window).is_some_and(|follower| {
                follower(ApprovalEvent::Asked {
                    ask: Box::new(ask.clone()),
                })
            });
            if !told {
                state.followers.remove(&window);
                drop(state);
                return self.nobody(&asking);
            }
            state.asks.insert(
                id,
                Pending {
                    window,
                    ask,
                    resolve,
                },
            );
            id
        };
        let _withdraw = Withdraw {
            approvals: self,
            asking: &asking,
            id,
        };
        match self.wait(&asking, resolved, changes).await {
            Ok(Ok(Resolution::Answered(answer))) => self.answered(&asking, answer),
            Ok(Ok(Resolution::Nobody) | Err(_)) => self.nobody(&asking),
            Err(outcome) => outcome,
        }
    }

    /// The person's answer, or what ended the wait first.
    async fn wait(
        &self,
        asking: &Asking<'_>,
        mut resolved: oneshot::Receiver<Resolution>,
        mut changes: Changes,
    ) -> Result<Result<Resolution, oneshot::error::RecvError>, Outcome> {
        let holder = asking.holder;
        loop {
            tokio::select! {
                resolution = &mut resolved => return Ok(resolution),
                () = holder.ended.cancelled() => return Err(Outcome::Ended),
                () = changes.next() => {
                    if self.policy.connection(&holder.context) != Some(holder.connection) {
                        return Err(Outcome::Moved);
                    }
                    match self.policy.authorize(&holder.context, asking.attributes, holder.actor) {
                        Err(blocked) if blocked.reason == BlockReason::NoApproval => {}
                        decided => return Err(Outcome::Decided(decided)),
                    }
                }
            }
        }
    }

    fn answered(&self, asking: &Asking<'_>, answer: ApprovalAnswer) -> Outcome {
        let Asking {
            holder, attributes, ..
        } = asking;
        let context = holder.context.as_str();
        let mut state = self.state();
        match answer {
            ApprovalAnswer::Deny => {
                self.audit(asking, "denied");
                let message = format!(
                    "{} {} on {context} was denied in Twigo, so Twigo did not send it",
                    attributes.verb,
                    attributes.target()
                );
                state.repeats.insert(
                    asking.repeat,
                    Repeat {
                        until: Instant::now() + REPEATS,
                        cover: Cover::Denied(message.clone()),
                    },
                );
                Outcome::Denied(message)
            }
            ApprovalAnswer::Once => {
                self.audit(asking, "once");
                state.repeats.insert(
                    asking.repeat,
                    Repeat {
                        until: Instant::now() + REPEATS,
                        cover: Cover::Once,
                    },
                );
                Outcome::Approved {
                    approval: Approval::once(context, holder.actor, attributes),
                    repeat: Some(asking.repeat),
                }
            }
            ApprovalAnswer::Lasting => {
                self.audit(asking, "lasting");
                let access = self.policy.access(context);
                let until = Timestamp::now()
                    .saturating_add(LASTING)
                    .unwrap_or(Timestamp::MAX);
                state.grants.insert(
                    (holder.process, context.to_owned()),
                    Grant {
                        until,
                        mode: access.mode,
                        source: access.source,
                        connection: holder.connection,
                        changes: self.policy.changes_of(context),
                    },
                );
                Outcome::Approved {
                    approval: Approval::until(context, holder.actor, until),
                    repeat: None,
                }
            }
        }
    }

    /// Denied, as no window could ask; its repeats too.
    fn nobody(&self, asking: &Asking<'_>) -> Outcome {
        self.audit(asking, "nobody");
        let message = asking.blocked.to_string();
        self.state().repeats.insert(
            asking.repeat,
            Repeat {
                until: Instant::now() + REPEATS,
                cover: Cover::Denied(message.clone()),
            },
        );
        Outcome::Denied(message)
    }

    /// A request covered by a "once" reached the server: its next repeat asks
    /// again.
    pub(crate) fn reached(&self, repeat: &Digest) {
        let mut state = self.state();
        if matches!(
            state.repeats.get(repeat).map(|repeat| &repeat.cover),
            Some(Cover::Once)
        ) {
            state.repeats.remove(repeat);
        }
    }

    fn holds(&self, context: &str, grant: &Grant) -> bool {
        let access = self.policy.access(context);
        Timestamp::now() < grant.until
            && self.policy.changes_of(context) == grant.changes
            && access.mode == grant.mode
            && access.source == grant.source
            && self.policy.connection(context) == Some(grant.connection)
    }

    /// `send` gets each ask still waiting for `window`, then each new one and
    /// each one withdrawn, until it says the window is gone. It must not call
    /// back into the broker.
    pub(crate) fn follow_window(
        &self,
        window: &str,
        send: impl FnMut(ApprovalEvent) -> bool + Send + 'static,
    ) {
        let mut follower: Follower = Box::new(send);
        let mut state = self.state();
        for pending in state.asks.values() {
            if *pending.window == *window
                && !follower(ApprovalEvent::Asked {
                    ask: Box::new(pending.ask.clone()),
                })
            {
                return;
            }
        }
        state.followers.insert(window.into(), follower);
    }

    pub(crate) fn answer(&self, window: &str, answer: AnswerApproval) -> Result<(), IpcError> {
        let mut state = self.state();
        let Some(pending) = state.asks.get(&answer.id.0) else {
            return Err(IpcError::new(
                ErrorKind::NotFound,
                "the process no longer waits for this answer",
            ));
        };
        if *pending.window != *window {
            return Err(IpcError::new(
                ErrorKind::Forbidden,
                "another window asks this",
            ));
        }
        let ask = &pending.ask;
        if answer.answer != ApprovalAnswer::Deny
            && ask.typed
            && answer.typed.as_deref() != Some(ask.context.as_str())
        {
            return Err(IpcError::new(
                ErrorKind::InvalidInput,
                format!("type {} to confirm", ask.context),
            ));
        }
        if answer.answer == ApprovalAnswer::Lasting && ask.lasting_minutes.is_none() {
            return Err(IpcError::new(
                ErrorKind::InvalidInput,
                "a delete is allowed only once",
            ));
        }
        let pending = state.asks.remove(&answer.id.0).expect("found above");
        // Its request may have gone meanwhile, and nothing waits then.
        let _ = pending.resolve.send(Resolution::Answered(answer.answer));
        Ok(())
    }

    /// The window went: its asks are withdrawn from what followed them, and
    /// denied, as nobody can answer them.
    pub(crate) fn drop_window(&self, window: &str) {
        let mut state = self.state();
        let mut follower = state.followers.remove(window);
        let gone: Vec<u32> = state
            .asks
            .iter()
            .filter(|(_, pending)| *pending.window == *window)
            .map(|(id, _)| *id)
            .collect();
        for id in gone {
            let pending = state.asks.remove(&id).expect("listed above");
            if let Some(send) = &mut follower
                && !send(ApprovalEvent::Withdrawn { id: ApprovalId(id) })
            {
                follower = None;
            }
            // Its request may have gone meanwhile, and nothing waits then.
            let _ = pending.resolve.send(Resolution::Nobody);
        }
    }

    /// The process's handle dropped: its grants end.
    pub(crate) fn end_process(&self, process: u64) {
        self.state()
            .grants
            .retain(|(granted, _), _| *granted != process);
    }

    fn audit(&self, asking: &Asking<'_>, answer: &str) {
        let Asking {
            holder, attributes, ..
        } = asking;
        self.policy.audit().record(&Entry::Approval {
            context: &holder.context,
            actor: holder.actor.name(),
            process: &holder.label,
            verb: &attributes.verb,
            target: &attributes.target(),
            mode: self.policy.access(&holder.context).mode,
            answer,
        });
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("approvals lock")
    }
}

/// The word a person reads in "Allow Terminal 2 to <verb> <target>": RBAC
/// calls an exec and an attach `create` or `get`.
fn verb(attributes: &Attributes) -> String {
    match (
        attributes.resource.as_deref(),
        attributes.subresource.as_deref(),
    ) {
        (Some("pods"), Some(session @ ("exec" | "attach"))) => session.to_owned(),
        _ => attributes.verb.clone(),
    }
}

fn is_delete(attributes: &Attributes) -> bool {
    matches!(attributes.verb.as_str(), "delete" | "deletecollection")
}

/// Withdraws an ask that is still waiting when its request stops waiting:
/// dropped as kubectl went, its process ended, or its decision changed.
struct Withdraw<'a> {
    approvals: &'a Approvals,
    asking: &'a Asking<'a>,
    id: u32,
}

impl Drop for Withdraw<'_> {
    fn drop(&mut self) {
        let mut state = self.approvals.state();
        let Some(pending) = state.asks.remove(&self.id) else {
            return;
        };
        if let Some(follower) = state.followers.get_mut(&pending.window)
            && !follower(ApprovalEvent::Withdrawn {
                id: ApprovalId(self.id),
            })
        {
            state.followers.remove(&pending.window);
        }
        drop(state);
        self.approvals.audit(self.asking, "withdrawn");
    }
}
