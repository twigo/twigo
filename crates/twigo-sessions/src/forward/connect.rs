//! A stream to a pod's port, as the connections read it: kube's, and a fake
//! one in the tests.

use futures::FutureExt;
use futures::future::BoxFuture;
use k8s_openapi::api::core::v1::Pod;
use kube::Api;
use kube::api::Portforwarder;
use tokio::io::{AsyncRead, AsyncWrite};

pub(super) trait Duplex: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> Duplex for T {}

pub(super) struct Connected {
    pub stream: Box<dyn Duplex>,
    /// The text the pod's side gave for the port, if it did, or `None` once
    /// that side is gone without one. Held to the end of the connection:
    /// kube ends its whole task when a future it handed out is dropped
    /// before it resolves.
    pub error: BoxFuture<'static, Option<String>>,
    /// What keeps it alive, and aborts it when dropped.
    pub held: Box<dyn Send>,
}

/// How a connection reaches a pod's port.
pub(super) trait Connect: Send + Sync {
    fn connect(
        &self,
        client: &kube::Client,
        namespace: &str,
        pod: &str,
        port: u16,
    ) -> BoxFuture<'static, Result<Connected, kube::Error>>;
}

pub(super) struct Kube;

/// The forwarder keeps its task when dropped.
struct Aborts(Portforwarder);

impl Drop for Aborts {
    fn drop(&mut self) {
        self.0.abort();
    }
}

impl Connect for Kube {
    fn connect(
        &self,
        client: &kube::Client,
        namespace: &str,
        pod: &str,
        port: u16,
    ) -> BoxFuture<'static, Result<Connected, kube::Error>> {
        let api = Api::<Pod>::namespaced(client.clone(), namespace);
        let pod = pod.to_owned();
        async move {
            let mut forwarder = api.portforward(&pod, &[port]).await?;
            let stream = forwarder.take_stream(port).expect("asked for");
            let error = forwarder.take_error(port).expect("asked for").boxed();
            Ok(Connected {
                stream: Box::new(stream),
                error,
                held: Box::new(Aborts(forwarder)),
            })
        }
        .boxed()
    }
}
