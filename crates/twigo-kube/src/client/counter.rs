//! The stream counter of a context (ARCHITECTURE 3.2): a budget per class of
//! stream, below every actor, since the API server allows 100 concurrent
//! streams per connection and hyper queues the rest without a word.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};

use http::{Request, Response, Uri};
use http_body::{Body, Frame, SizeHint};
use tokio::sync::{OwnedSemaphorePermit, Semaphore, watch};
use tower::{BoxError, Layer, Service, ServiceExt};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Class {
    Watch,
    Log,
    Request,
}

impl Class {
    pub fn of(uri: &Uri) -> Self {
        let query = uri.query().unwrap_or_default();
        let flag = |name: &str| {
            form_urlencoded::parse(query.as_bytes())
                .find(|(key, _)| key == name)
                .is_some_and(|(_, value)| is_true(&value))
        };
        if flag("watch") {
            Class::Watch
        } else if uri.path().ends_with("/log") && flag("follow") {
            Class::Log
        } else {
            Class::Request
        }
    }
}

/// How the API server reads a boolean query parameter: its first value is
/// false only when it is `0` or `false` in any case
/// (apimachinery's `Convert_Slice_string_To_bool`).
fn is_true(value: &str) -> bool {
    value != "0" && !value.eq_ignore_ascii_case("false")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Budgets {
    pub watches: usize,
    pub logs: usize,
    pub requests: usize,
}

impl Default for Budgets {
    fn default() -> Self {
        Self {
            watches: 24,
            logs: 32,
            requests: 28,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Slots {
    pub held: usize,
    pub queued: usize,
}

/// What each class holds and how many of its streams wait.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Usage {
    pub watches: Slots,
    pub logs: Slots,
    pub requests: Slots,
}

impl Usage {
    fn slots(&mut self, class: Class) -> &mut Slots {
        match class {
            Class::Watch => &mut self.watches,
            Class::Log => &mut self.logs,
            Class::Request => &mut self.requests,
        }
    }
}

#[derive(Clone)]
pub struct Counter(Arc<Inner>);

struct Inner {
    watches: Arc<Semaphore>,
    logs: Arc<Semaphore>,
    requests: Arc<Semaphore>,
    usage: watch::Sender<Usage>,
}

impl Counter {
    pub fn new(budgets: Budgets) -> Self {
        Self(Arc::new(Inner {
            watches: Arc::new(Semaphore::new(budgets.watches)),
            logs: Arc::new(Semaphore::new(budgets.logs)),
            requests: Arc::new(Semaphore::new(budgets.requests)),
            usage: watch::Sender::new(Usage::default()),
        }))
    }

    pub fn usage(&self) -> watch::Receiver<Usage> {
        self.0.usage.subscribe()
    }

    /// Waits until the class has a free stream; a stream that has to wait
    /// counts as queued meanwhile.
    pub async fn admit(&self, class: Class) -> Permit {
        let semaphore = match class {
            Class::Watch => &self.0.watches,
            Class::Log => &self.0.logs,
            Class::Request => &self.0.requests,
        };
        let permit = match Arc::clone(semaphore).try_acquire_owned() {
            Ok(permit) => permit,
            Err(_) => {
                let _queued = Queued::new(self, class);
                Arc::clone(semaphore)
                    .acquire_owned()
                    .await
                    .expect("the counter never closes its semaphores")
            }
        };
        self.change(class, |slots| slots.held += 1);
        Permit {
            counter: self.clone(),
            class,
            _permit: permit,
        }
    }

    fn change(&self, class: Class, change: impl FnOnce(&mut Slots)) {
        self.0.usage.send_modify(|usage| change(usage.slots(class)));
    }
}

/// Counts a waiting stream until it is admitted or given up.
struct Queued<'a> {
    counter: &'a Counter,
    class: Class,
}

impl<'a> Queued<'a> {
    fn new(counter: &'a Counter, class: Class) -> Self {
        counter.change(class, |slots| slots.queued += 1);
        Self { counter, class }
    }
}

impl Drop for Queued<'_> {
    fn drop(&mut self) {
        self.counter.change(self.class, |slots| slots.queued -= 1);
    }
}

pub struct Permit {
    counter: Counter,
    class: Class,
    _permit: OwnedSemaphorePermit,
}

impl Drop for Permit {
    fn drop(&mut self) {
        self.counter.change(self.class, |slots| slots.held -= 1);
    }
}

#[derive(Clone)]
pub struct CounterLayer(pub Counter);

impl<S> Layer<S> for CounterLayer {
    type Service = Counted<S>;

    fn layer(&self, inner: S) -> Self::Service {
        Counted {
            counter: self.0.clone(),
            inner,
        }
    }
}

#[derive(Clone)]
pub struct Counted<S> {
    counter: Counter,
    inner: S,
}

impl<S, B, R> Service<Request<B>> for Counted<S>
where
    S: Service<Request<B>, Response = Response<R>> + Clone + Send + 'static,
    S::Future: Send,
    S::Error: Into<BoxError>,
    B: Send + 'static,
{
    type Response = Response<Permitted<R>>;
    type Error = BoxError;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, BoxError>> + Send>>;

    fn poll_ready(&mut self, _: &mut Context<'_>) -> Poll<Result<(), BoxError>> {
        // Readiness is the inner service's, awaited once admitted.
        Poll::Ready(Ok(()))
    }

    fn call(&mut self, request: Request<B>) -> Self::Future {
        let counter = self.counter.clone();
        let inner = self.inner.clone();
        Box::pin(async move {
            let permit = counter.admit(Class::of(request.uri())).await;
            let response = inner.oneshot(request).await.map_err(Into::into)?;
            Ok(response.map(|body| Permitted {
                body,
                permit: Some(permit),
            }))
        })
    }
}

/// A response body that holds its stream's permit until it ends or is
/// dropped.
pub struct Permitted<B> {
    body: B,
    permit: Option<Permit>,
}

impl<B> Body for Permitted<B>
where
    B: Body + Unpin,
{
    type Data = B::Data;
    type Error = B::Error;

    fn poll_frame(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
    ) -> Poll<Option<Result<Frame<Self::Data>, Self::Error>>> {
        let polled = Pin::new(&mut self.body).poll_frame(cx);
        if matches!(polled, Poll::Ready(None | Some(Err(_)))) {
            self.permit.take();
        }
        polled
    }

    fn is_end_stream(&self) -> bool {
        self.body.is_end_stream()
    }

    fn size_hint(&self) -> SizeHint {
        self.body.size_hint()
    }
}

#[cfg(test)]
mod tests {
    use std::convert::Infallible;
    use std::time::Duration;

    use http_body_util::{BodyExt, Empty};

    use super::*;

    #[test]
    fn classes() {
        let class = |uri: &str| Class::of(&uri.parse().unwrap());
        assert_eq!(class("/api/v1/pods?watch=true"), Class::Watch);
        assert_eq!(
            class("/api/v1/pods?watch=1&resourceVersion=4"),
            Class::Watch
        );
        assert_eq!(class("/api/v1/pods?watch="), Class::Watch);
        assert_eq!(class("/api/v1/pods?watch=FALSE"), Class::Request);
        assert_eq!(class("/api/v1/pods?watch=0&watch=1"), Class::Request);
        assert_eq!(class("/api/v1/pods"), Class::Request);
        assert_eq!(
            class("/api/v1/namespaces/a/pods/p/log?follow=true"),
            Class::Log
        );
        assert_eq!(
            class("/api/v1/namespaces/a/pods/p/log?follow=false"),
            Class::Request
        );
        assert_eq!(class("/api/v1/namespaces/a/pods/p/log"), Class::Request);
        assert_eq!(
            class("/api/v1/namespaces/a/configmaps/log?follow=true"),
            Class::Log
        );
    }

    fn counted(
        counter: &Counter,
    ) -> impl Service<
        Request<()>,
        Response = Response<Permitted<Empty<bytes::Bytes>>>,
        Error = BoxError,
        Future: Send + 'static,
    > + Clone
    + Send
    + 'static {
        let ok = |_| async { Ok::<_, Infallible>(Response::new(Empty::new())) };
        CounterLayer(counter.clone()).layer(tower::service_fn(ok))
    }

    fn request(uri: &str) -> Request<()> {
        Request::get(uri).body(()).unwrap()
    }

    #[tokio::test]
    async fn a_stream_over_its_budget_waits_until_one_ends() {
        let counter = Counter::new(Budgets {
            watches: 2,
            logs: 1,
            requests: 1,
        });
        let service = counted(&counter);
        let first = service
            .clone()
            .oneshot(request("/w?watch=1"))
            .await
            .unwrap();
        let _second = service
            .clone()
            .oneshot(request("/w?watch=1"))
            .await
            .unwrap();
        let third = tokio::spawn(service.clone().oneshot(request("/w?watch=1")));
        let mut usage = counter.usage();
        usage
            .wait_for(|usage| usage.watches.queued == 1)
            .await
            .unwrap();
        assert_eq!(usage.borrow().watches, Slots { held: 2, queued: 1 });

        let log = service
            .clone()
            .oneshot(request("/p/log?follow=1"))
            .await
            .unwrap();
        let get = service.clone().oneshot(request("/version")).await.unwrap();
        assert_eq!(usage.borrow().logs, Slots { held: 1, queued: 0 });
        assert_eq!(usage.borrow().requests, Slots { held: 1, queued: 0 });
        assert!(!third.is_finished());

        drop(first);
        let third = tokio::time::timeout(Duration::from_secs(1), third)
            .await
            .expect("the third watch starts once the first ends")
            .unwrap()
            .unwrap();
        assert_eq!(usage.borrow().watches, Slots { held: 2, queued: 0 });

        let mut body = get.into_body();
        assert!(body.frame().await.is_none());
        assert_eq!(usage.borrow().requests, Slots::default());
        drop((third, log));
        assert_eq!(usage.borrow().logs, Slots::default());
    }

    #[tokio::test]
    async fn a_stream_given_up_while_queued_leaves_the_queue() {
        let counter = Counter::new(Budgets {
            watches: 1,
            logs: 1,
            requests: 1,
        });
        let service = counted(&counter);
        let _held = service.clone().oneshot(request("/version")).await.unwrap();
        let waiting = tokio::spawn(service.oneshot(request("/version")));
        let mut usage = counter.usage();
        usage
            .wait_for(|usage| usage.requests.queued == 1)
            .await
            .unwrap();
        waiting.abort();
        let left = usage.wait_for(|usage| usage.requests.queued == 0);
        tokio::time::timeout(Duration::from_secs(1), left)
            .await
            .expect("the aborted stream leaves the queue")
            .unwrap();
        assert_eq!(usage.borrow().requests.held, 1);
    }
}
