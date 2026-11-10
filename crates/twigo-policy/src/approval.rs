//! What a person allowed a process that reaches a cluster through the policy
//! proxy (ARCHITECTURE 6.4): the approval a request carries as an extension,
//! which the gate reads with its attributes.
//!
//! Only the approval broker in `twigo-core` constructs one, for a request
//! whose ask the person answered or that a grant they gave covers: anything
//! else that attached one would go around the person.

use jiff::Timestamp;
use twigo_ipc::RequestClass;

use crate::{Actor, Attributes};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Approval {
    context: String,
    actor: Actor,
    scope: Scope,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Scope {
    /// "Once": the request the person saw, by its verb, decoded path and
    /// class.
    Exact {
        verb: String,
        path: String,
        class: RequestClass,
    },
    /// "For 15 minutes": every write and exec until then, but deletes, which
    /// each ask.
    Until(Timestamp),
}

impl Approval {
    /// The person allowed exactly this request.
    pub fn once(context: &str, actor: Actor, attributes: &Attributes) -> Self {
        Self {
            context: context.to_owned(),
            actor,
            scope: Scope::Exact {
                verb: attributes.verb.clone(),
                path: attributes.path.clone(),
                class: attributes.class,
            },
        }
    }

    /// The person allowed the process's writes and exec on the context until
    /// `until`, deletes excepted.
    pub fn until(context: &str, actor: Actor, until: Timestamp) -> Self {
        Self {
            context: context.to_owned(),
            actor,
            scope: Scope::Until(until),
        }
    }

    /// Whether it lets `actor`'s write or exec of `attributes` through on
    /// `context` at `now`.
    pub(crate) fn covers(
        &self,
        context: &str,
        actor: Actor,
        attributes: &Attributes,
        now: Timestamp,
    ) -> bool {
        let approvable = matches!(attributes.class, RequestClass::Write | RequestClass::Exec);
        approvable
            && self.context == context
            && self.actor == actor
            && match &self.scope {
                Scope::Exact { verb, path, class } => {
                    *verb == attributes.verb
                        && *path == attributes.path
                        && *class == attributes.class
                }
                Scope::Until(until) => {
                    now < *until
                        && !matches!(attributes.verb.as_str(), "delete" | "deletecollection")
                }
            }
    }
}

#[cfg(test)]
mod tests {
    use http::Request;
    use jiff::SignedDuration;

    use super::*;

    fn read(method: &str, uri: &str) -> Attributes {
        Attributes::of(&Request::builder().method(method).uri(uri).body(()).unwrap())
    }

    const CONFIGMAP: &str = "/api/v1/namespaces/a/configmaps/c";

    #[test]
    fn once_covers_exactly_the_request_it_was_given_for() {
        let now = Timestamp::now();
        let patch = read("PATCH", CONFIGMAP);
        let once = Approval::once("c", Actor::Terminal, &patch);
        assert!(once.covers("c", Actor::Terminal, &patch, now));
        let with_a_query = read("PATCH", &format!("{CONFIGMAP}?fieldManager=kubectl"));
        assert!(
            once.covers("c", Actor::Terminal, &with_a_query, now),
            "the query is no part of what the gate reads of it"
        );
        let later = now.checked_add(SignedDuration::from_hours(24)).unwrap();
        assert!(once.covers("c", Actor::Terminal, &patch, later));

        for other in [
            read("PUT", CONFIGMAP),
            read("DELETE", CONFIGMAP),
            read("PATCH", "/api/v1/namespaces/a/configmaps/d"),
            read("PATCH", "/api/v1/namespaces/a/configmaps/c%2Fd"),
        ] {
            assert!(
                !once.covers("c", Actor::Terminal, &other, now),
                "{} {}",
                other.verb,
                other.path
            );
        }
        assert!(!once.covers("d", Actor::Terminal, &patch, now));
        assert!(!once.covers("c", Actor::Agent, &patch, now));
    }

    #[test]
    fn once_for_an_exec_covers_that_exec_and_not_its_other_class() {
        let now = Timestamp::now();
        let exec = Request::post("/api/v1/namespaces/a/pods/p/exec?command=sh")
            .header(http::header::UPGRADE, "SPDY/3.1")
            .body(())
            .unwrap();
        let exec = Attributes::of(&exec);
        let once = Approval::once("c", Actor::Terminal, &exec);
        assert!(once.covers("c", Actor::Terminal, &exec, now));
        let mut other_class = exec.clone();
        other_class.class = RequestClass::Write;
        assert!(!once.covers("c", Actor::Terminal, &other_class, now));
    }

    #[test]
    fn a_lasting_one_covers_writes_and_exec_but_deletes_until_its_time() {
        let now = Timestamp::now();
        let until = now.checked_add(SignedDuration::from_mins(15)).unwrap();
        let lasting = Approval::until("c", Actor::Terminal, until);
        let exec = Attributes::action("create", "pods", Some("exec"), Some("a"), Some("p"));
        for covered in [
            read("POST", "/api/v1/namespaces/a/configmaps"),
            read("PATCH", CONFIGMAP),
            read("PUT", CONFIGMAP),
            read("PATCH", "/apis/apps/v1/namespaces/a/deployments/d/scale"),
            exec,
        ] {
            assert!(
                lasting.covers("c", Actor::Terminal, &covered, now),
                "{}",
                covered.verb
            );
            assert!(
                !lasting.covers("c", Actor::Terminal, &covered, until),
                "{} at its end",
                covered.verb
            );
        }
        for delete in [
            read("DELETE", CONFIGMAP),
            read("DELETE", "/api/v1/namespaces/a/configmaps"),
        ] {
            assert!(
                !lasting.covers("c", Actor::Terminal, &delete, now),
                "{}",
                delete.verb
            );
        }
        let write = read("PATCH", CONFIGMAP);
        assert!(!lasting.covers("d", Actor::Terminal, &write, now));
        assert!(!lasting.covers("c", Actor::Helm, &write, now));
    }

    #[test]
    fn no_approval_covers_what_needs_none() {
        let now = Timestamp::now();
        let get = read("GET", CONFIGMAP);
        let until = now.checked_add(SignedDuration::from_mins(15)).unwrap();
        assert!(!Approval::once("c", Actor::Terminal, &get).covers(
            "c",
            Actor::Terminal,
            &get,
            now
        ));
        assert!(!Approval::until("c", Actor::Terminal, until).covers(
            "c",
            Actor::Terminal,
            &get,
            now
        ));
    }
}
