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

use http::Method;
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
const REPEATS: SignedDuration = SignedDuration::from_secs(15);

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
    /// Numbers each "once", so that a request gives back or uses up only
    /// its own.
    onces: u64,
}

impl State {
    /// What covers `repeat` at `now`. The wall clock, as the gate's for an
    /// unlock, runs on while the machine sleeps, which `Instant` on macOS
    /// does not.
    fn cover(&mut self, repeat: &Digest, now: Timestamp) -> Option<&mut Cover> {
        self.repeats.retain(|_, held| held.until > now);
        self.repeats.get_mut(repeat).map(|held| &mut held.cover)
    }

    /// `cover` for the repeats of `repeat` from `now` on.
    fn cover_repeats(&mut self, repeat: Digest, cover: Cover, now: Timestamp) {
        let until = now.saturating_add(REPEATS).unwrap_or(Timestamp::MAX);
        self.repeats.insert(repeat, Repeat { until, cover });
    }
}

type Follower = Box<dyn FnMut(ApprovalEvent) -> bool + Send>;

struct Pending {
    window: Arc<str>,
    process: u64,
    /// Its token's connection.
    connection: u64,
    delete: bool,
    ask: ApprovalAsk,
    audited: Audited,
    resolve: oneshot::Sender<Resolution>,
}

/// What the audit log names of an ask's request: never a value or a token.
struct Audited {
    context: String,
    actor: &'static str,
    process: Arc<str>,
    verb: String,
    target: String,
}

enum Resolution {
    Denied,
    Once,
    /// A grant "for 15 minutes" until then covers it: the person's answer to
    /// it, or to another ask of its process on its context.
    Granted(Timestamp),
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
    /// [`Policy::revision`] of the context when it was given.
    revision: Option<u64>,
}

struct Repeat {
    until: Timestamp,
    cover: Cover,
}

enum Cover {
    /// Every repeat, in these words.
    Denied(String),
    /// The approval the person gave, for the repeats it covers, one at a
    /// time: a request takes it as it is sent and gives it back only when it
    /// did not reach the server, after the proxy's own `429` or a pod's
    /// stream answered other than `101`.
    Once {
        approval: Approval,
        id: u64,
        taken: bool,
    },
}

/// A request the gate would stop for want of an approval.
pub(crate) struct Asking<'a> {
    pub holder: &'a Holder,
    pub method: &'a Method,
    pub attributes: &'a Attributes,
    pub body: &'a [u8],
    /// The gate's words for it, should no window ask.
    pub blocked: Box<Blocked>,
    pub repeat: Digest,
    /// The client's `Kubectl-Command`: a label, never checked.
    pub command: Option<String>,
    pub impersonate: Option<String>,
}

pub(crate) enum Outcome<'a> {
    /// Send it with `approval`, holding the "once" it took, if any.
    Approved {
        approval: Approval,
        once: Option<Once<'a>>,
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
    ) -> Outcome<'_> {
        let Asking {
            holder, attributes, ..
        } = &asking;
        let context = holder.context.as_str();
        // Whatever RBAC calls it: the old proxy path names every method
        // `proxy`.
        let delete = *asking.method == Method::DELETE;
        // Before the detail's dry run, which a change may outlast.
        let changes = Changes::new(&self.policy, &self.catalog);
        {
            let mut state = self.state();
            match state.cover(&asking.repeat, Timestamp::now()) {
                Some(Cover::Denied(message)) => return Outcome::Denied(message.clone()),
                Some(Cover::Once {
                    approval,
                    id,
                    taken,
                }) if !*taken
                    && approval.covers(context, holder.actor, attributes, Timestamp::now()) =>
                {
                    *taken = true;
                    return Outcome::Approved {
                        approval: approval.clone(),
                        once: Some(Once::taken(self, asking.repeat, *id)),
                    };
                }
                Some(Cover::Once { .. }) | None => {}
            }
            let grant = state.grants.get(&(holder.process, context.to_owned()));
            if !delete
                && let Some(grant) = grant
                && self.holds(context, grant)
            {
                return Outcome::Approved {
                    approval: Approval::until(context, holder.actor, grant.until),
                    once: None,
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
                target: target(attributes, asking.body),
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
                    process: holder.process,
                    connection: holder.connection,
                    delete,
                    ask,
                    audited: asking.audited(),
                    resolve,
                },
            );
            id
        };
        let _withdraw = Withdraw {
            approvals: self,
            id,
        };
        self.wait(&asking, resolved, changes).await
    }

    /// The person's answer, or what ended the wait first.
    async fn wait(
        &self,
        asking: &Asking<'_>,
        mut resolved: oneshot::Receiver<Resolution>,
        mut changes: Changes,
    ) -> Outcome<'_> {
        let holder = asking.holder;
        loop {
            tokio::select! {
                // An answer that comes as the process ends lets nothing go.
                biased;
                () = holder.ended.cancelled() => return Outcome::Ended,
                resolution = &mut resolved => return match resolution {
                    Ok(resolution) => self.answered(asking, resolution),
                    Err(_) => self.nobody(asking),
                },
                () = changes.next() => {
                    if self.policy.connection(&holder.context) != Some(holder.connection) {
                        return Outcome::Moved;
                    }
                    match self.policy.authorize(&holder.context, asking.attributes, holder.actor) {
                        Err(blocked) if blocked.reason == BlockReason::NoApproval => {}
                        decided => return Outcome::Decided(decided),
                    }
                }
            }
        }
    }

    /// What ended an ask, audited where it ended.
    fn answered(&self, asking: &Asking<'_>, resolution: Resolution) -> Outcome<'_> {
        let Asking {
            holder, attributes, ..
        } = asking;
        let context = holder.context.as_str();
        let mut state = self.state();
        match resolution {
            Resolution::Denied => {
                let message = format!(
                    "{} {} on {context} was denied in Twigo, so Twigo did not send it",
                    attributes.verb,
                    attributes.target()
                );
                let cover = Cover::Denied(message.clone());
                state.cover_repeats(asking.repeat, cover, Timestamp::now());
                Outcome::Denied(message)
            }
            Resolution::Once => {
                let approval = Approval::once(context, holder.actor, attributes);
                let id = state.onces;
                state.onces += 1;
                let cover = Cover::Once {
                    approval: approval.clone(),
                    id,
                    taken: true,
                };
                state.cover_repeats(asking.repeat, cover, Timestamp::now());
                Outcome::Approved {
                    approval,
                    once: Some(Once::taken(self, asking.repeat, id)),
                }
            }
            Resolution::Granted(until) => Outcome::Approved {
                approval: Approval::until(context, holder.actor, until),
                once: None,
            },
            Resolution::Nobody => {
                drop(state);
                self.unasked(asking)
            }
        }
    }

    /// Denied, as no window could ask; its repeats too.
    fn nobody(&self, asking: &Asking<'_>) -> Outcome<'_> {
        self.audit(&asking.audited(), "nobody");
        self.unasked(asking)
    }

    /// [`Approvals::nobody`], but not audited.
    fn unasked(&self, asking: &Asking<'_>) -> Outcome<'_> {
        let message = asking.blocked.to_string();
        let cover = Cover::Denied(message.clone());
        self.state()
            .cover_repeats(asking.repeat, cover, Timestamp::now());
        Outcome::Denied(message)
    }

    fn holds(&self, context: &str, grant: &Grant) -> bool {
        let access = self.policy.access(context);
        Timestamp::now() < grant.until
            && self.policy.changes_of(context) == grant.changes
            && self.policy.revision(context) == grant.revision
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
        let (resolution, audited) = match answer.answer {
            ApprovalAnswer::Deny => (Resolution::Denied, "denied"),
            ApprovalAnswer::Once => (Resolution::Once, "once"),
            ApprovalAnswer::Lasting => {
                let until = Timestamp::now()
                    .saturating_add(LASTING)
                    .unwrap_or(Timestamp::MAX);
                (Resolution::Granted(until), "lasting")
            }
        };
        let granted = match resolution {
            Resolution::Granted(until) => Some(until),
            _ => None,
        };
        if pending.resolve.send(resolution).is_err() {
            // Its request went and has not withdrawn the ask yet.
            if let Some(follower) = state.followers.get_mut(&pending.window)
                && !follower(ApprovalEvent::Withdrawn { id: answer.id })
            {
                state.followers.remove(&pending.window);
            }
            drop(state);
            self.audit(&pending.audited, "withdrawn");
            return Err(IpcError::new(
                ErrorKind::NotFound,
                "the process no longer waits for this answer",
            ));
        }
        let mut ended = Vec::new();
        if let Some(until) = granted {
            let context = pending.ask.context.as_str();
            let grant = self.grant(context, pending.connection, until);
            state
                .grants
                .insert((pending.process, context.to_owned()), grant);
            ended = Self::granted(&mut state, pending.process, context, until);
        }
        drop(state);
        self.audit(&pending.audited, audited);
        for (audited, answer) in ended {
            self.audit(&audited, answer);
        }
        Ok(())
    }

    /// "For 15 minutes" until `until` on `context`, held to what decides it
    /// now.
    fn grant(&self, context: &str, connection: u64, until: Timestamp) -> Grant {
        let access = self.policy.access(context);
        Grant {
            until,
            mode: access.mode,
            source: access.source,
            connection,
            changes: self.policy.changes_of(context),
            revision: self.policy.revision(context),
        }
    }

    /// The other asks of `process` on `context` that its new grant covers go
    /// on under it, withdrawn from their window: every one but a delete's.
    /// Says how each ended, for the audit log.
    fn granted(
        state: &mut State,
        process: u64,
        context: &str,
        until: Timestamp,
    ) -> Vec<(Audited, &'static str)> {
        let covered: Vec<u32> = state
            .asks
            .iter()
            .filter(|(_, other)| {
                other.process == process && other.ask.context == context && !other.delete
            })
            .map(|(id, _)| *id)
            .collect();
        let mut ended = Vec::new();
        for id in covered {
            let other = state.asks.remove(&id).expect("listed above");
            if let Some(follower) = state.followers.get_mut(&other.window)
                && !follower(ApprovalEvent::Withdrawn { id: ApprovalId(id) })
            {
                state.followers.remove(&other.window);
            }
            let taken = other.resolve.send(Resolution::Granted(until)).is_ok();
            ended.push((other.audited, if taken { "lasting" } else { "withdrawn" }));
        }
        ended
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
        let mut ended = Vec::new();
        for id in gone {
            let pending = state.asks.remove(&id).expect("listed above");
            if let Some(send) = &mut follower
                && !send(ApprovalEvent::Withdrawn { id: ApprovalId(id) })
            {
                follower = None;
            }
            // Its request may have gone and not withdrawn the ask yet.
            let taken = pending.resolve.send(Resolution::Nobody).is_ok();
            ended.push((pending.audited, if taken { "nobody" } else { "withdrawn" }));
        }
        drop(state);
        for (audited, answer) in ended {
            self.audit(&audited, answer);
        }
    }

    /// The process's handle dropped: its grants end.
    pub(crate) fn end_process(&self, process: u64) {
        self.state()
            .grants
            .retain(|(granted, _), _| *granted != process);
    }

    fn audit(&self, audited: &Audited, answer: &str) {
        self.policy.audit().record(&Entry::Approval {
            context: &audited.context,
            actor: audited.actor,
            process: &audited.process,
            verb: &audited.verb,
            target: &audited.target,
            mode: self.policy.access(&audited.context).mode,
            answer,
        });
    }

    fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().expect("approvals lock")
    }
}

impl Asking<'_> {
    fn audited(&self) -> Audited {
        Audited {
            context: self.holder.context.clone(),
            actor: self.holder.actor.name(),
            process: Arc::clone(&self.holder.label),
            verb: self.attributes.verb.clone(),
            target: self.attributes.target(),
        }
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

/// What a person reads after the verb, unlike [`Attributes::target`], which
/// the gate and the audit log name: a create by the name its body gives,
/// or its `generateName` and `…`, and a pod's exec, attach or port-forward
/// by the pod, as the verb says the rest.
fn target(attributes: &Attributes, body: &[u8]) -> String {
    let mut named = attributes.clone();
    if attributes.verb == "create" && attributes.name.is_none() && attributes.subresource.is_none()
    {
        let object: Option<serde_json::Value> = serde_json::from_slice(body).ok();
        let metadata = object.as_ref().map(|object| &object["metadata"]);
        named.name = metadata.and_then(|metadata| match metadata["name"].as_str() {
            Some(name) => Some(name.to_owned()),
            None => Some(format!("{}…", metadata["generateName"].as_str()?)),
        });
    }
    if attributes.opens_a_pod_stream() {
        named.subresource = None;
    }
    named.target()
}

/// A "once" its request took as it was sent. Dropped, it is gone, as the
/// request may have reached the server, its client gone or not; given back,
/// the next repeat may take it.
pub(crate) struct Once<'a> {
    approvals: &'a Approvals,
    repeat: Digest,
    id: u64,
    given_back: bool,
}

impl<'a> Once<'a> {
    fn taken(approvals: &'a Approvals, repeat: Digest, id: u64) -> Self {
        Self {
            approvals,
            repeat,
            id,
            given_back: false,
        }
    }

    /// Its request reached no server.
    pub(crate) fn give_back(mut self) {
        self.given_back = true;
        let mut state = self.approvals.state();
        if let Some(Cover::Once { id, taken, .. }) = state
            .repeats
            .get_mut(&self.repeat)
            .map(|repeat| &mut repeat.cover)
            && *id == self.id
        {
            *taken = false;
        }
    }
}

impl Drop for Once<'_> {
    fn drop(&mut self) {
        if self.given_back {
            return;
        }
        let mut state = self.approvals.state();
        let ours = matches!(
            state.repeats.get(&self.repeat).map(|repeat| &repeat.cover),
            Some(Cover::Once { id, .. }) if *id == self.id
        );
        if ours {
            state.repeats.remove(&self.repeat);
        }
    }
}

/// Withdraws an ask that is still waiting when its request stops waiting:
/// dropped as kubectl went, its process ended, or its decision changed.
struct Withdraw<'a> {
    approvals: &'a Approvals,
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
        self.approvals.audit(&pending.audited, "withdrawn");
    }
}

#[cfg(test)]
mod tests {
    use tokio_util::sync::CancellationToken;
    use twigo_ipc::RequestClass;
    use twigo_policy::Actor;

    use super::*;

    fn ask(id: u32) -> ApprovalAsk {
        ApprovalAsk {
            id: ApprovalId(id),
            context: "kind-a".to_owned(),
            process: "Terminal 1".to_owned(),
            command: None,
            verb: "create".to_owned(),
            class: RequestClass::Write,
            target: "configmaps in a".to_owned(),
            impersonate: None,
            detail: ApprovalDetail::Unknown {
                reason: twigo_ipc::NoDiff::NotAResource,
                body: None,
            },
            typed: false,
            lasting_minutes: Some(15),
        }
    }

    fn audited() -> Audited {
        Audited {
            context: "kind-a".to_owned(),
            actor: "terminal",
            process: "Terminal 1".into(),
            verb: "create".to_owned(),
            target: "configmaps in a".to_owned(),
        }
    }

    /// The answers the audit log holds, in order.
    fn answers(audit: &std::path::Path) -> Vec<String> {
        let text = std::fs::read_to_string(audit).unwrap_or_default();
        text.lines()
            .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
            .map(|line| line["answer"].as_str().unwrap().to_owned())
            .collect()
    }

    #[test]
    fn an_answer_is_taken_only_by_its_waiting_request_and_audited_either_way() {
        let dir = tempfile::tempdir().unwrap();
        let audit = dir.path().join("audit.jsonl");
        let policy = Policy::new(
            twigo_policy::PolicyFile::default(),
            |_| Some(twigo_policy::Metadata::default()),
            twigo_policy::Choices::default(),
            twigo_policy::Audit::open(&audit),
        );
        let (_catalog, catalog) = watch::channel(None);
        let approvals = Approvals::new(policy, catalog);
        let (events, mut told) = tokio::sync::mpsc::unbounded_channel();
        approvals.follow_window("main", move |event| events.send(event).is_ok());
        let answer = |id| AnswerApproval {
            id: ApprovalId(id),
            answer: ApprovalAnswer::Once,
            typed: None,
        };

        // Its request went, and has not withdrawn it yet.
        let (resolve, resolved) = oneshot::channel();
        drop(resolved);
        let pending = Pending {
            window: "main".into(),
            process: 0,
            connection: 0,
            delete: false,
            ask: ask(7),
            audited: audited(),
            resolve,
        };
        approvals.state().asks.insert(7, pending);
        let refused = approvals.answer("main", answer(7));
        assert_eq!(refused.unwrap_err().kind, ErrorKind::NotFound);
        assert_eq!(
            told.try_recv().unwrap(),
            ApprovalEvent::Withdrawn { id: ApprovalId(7) }
        );
        assert_eq!(answers(&audit), ["withdrawn"]);

        // Its request waits: the answer is audited as it is taken.
        let (resolve, _resolved) = oneshot::channel();
        let pending = Pending {
            window: "main".into(),
            process: 0,
            connection: 0,
            delete: false,
            ask: ask(8),
            audited: audited(),
            resolve,
        };
        approvals.state().asks.insert(8, pending);
        approvals.answer("main", answer(8)).unwrap();
        assert_eq!(answers(&audit), ["withdrawn", "once"]);
    }

    #[test]
    fn a_cover_lasts_15_seconds_of_the_wall_clock() {
        let mut state = State::default();
        let at = Timestamp::from_second(1_800_000_000).unwrap();
        let later = |millis| at.checked_add(SignedDuration::from_millis(millis)).unwrap();
        state.cover_repeats([1; 32], Cover::Denied("denied".to_owned()), at);
        assert!(state.cover(&[1; 32], later(14_999)).is_some());
        assert!(state.cover(&[1; 32], later(15_000)).is_none());
        assert!(state.repeats.is_empty(), "gone for good");
    }

    #[tokio::test]
    async fn an_answer_that_comes_as_the_process_ends_lets_nothing_go() {
        let policy = Policy::open();
        let (_catalog, catalog) = watch::channel(None);
        let approvals = Approvals::new(Arc::clone(&policy), catalog.clone());
        let ended = CancellationToken::new();
        let holder = Holder {
            process: 0,
            label: "Terminal 1".into(),
            window: None,
            actor: Actor::Terminal,
            context: "kind-a".to_owned(),
            connection: 0,
            prefix: String::new(),
            digest: [0; 32],
            ended: ended.clone(),
        };
        let request = http::Request::post("/api/v1/namespaces/a/configmaps")
            .body(())
            .unwrap();
        let attributes = Attributes::of(&request);
        let asking = Asking {
            holder: &holder,
            method: &Method::POST,
            attributes: &attributes,
            blocked: Box::new(Blocked {
                context: "kind-a".to_owned(),
                mode: Mode::Guarded,
                source: ModeSource::User,
                class: RequestClass::Write,
                reason: BlockReason::NoApproval,
                verb: attributes.verb.clone(),
                target: attributes.target(),
            }),
            body: &[],
            repeat: [0; 32],
            command: None,
            impersonate: None,
        };
        ended.cancel();
        for _ in 0..64 {
            let (resolve, resolved) = oneshot::channel();
            assert!(resolve.send(Resolution::Once).is_ok());
            let changes = Changes::new(&policy, &catalog);
            let outcome = approvals.wait(&asking, resolved, changes).await;
            assert!(matches!(outcome, Outcome::Ended), "the answer won");
        }
    }
}
