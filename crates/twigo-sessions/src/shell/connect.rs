//! The connected process, as the session reads it: kube's, and a fake one on
//! the same pipes in the tests.

use futures::FutureExt;
use futures::channel::mpsc;
use futures::future::BoxFuture;
use k8s_openapi::api::core::v1::Pod;
use k8s_openapi::apimachinery::pkg::apis::meta::v1::Status;
use kube::Api;
use kube::api::{AttachParams, TerminalSize};
use tokio::io::{ReadHalf, SimplexStream, WriteHalf};

use super::{Join, Spec};
use crate::flow::FRAME_MAX;

pub(super) struct Connected {
    pub stdout: ReadHalf<SimplexStream>,
    pub stderr: Option<ReadHalf<SimplexStream>>,
    pub stdin: Option<WriteHalf<SimplexStream>>,
    pub resize: Option<mpsc::Sender<TerminalSize>>,
    pub status: BoxFuture<'static, Option<Status>>,
    /// What keeps it alive, and aborts it when dropped.
    pub held: Box<dyn Send>,
}

/// How a session reaches its process.
pub(super) trait Connect: Send + Sync {
    fn connect(&self, spec: &Spec) -> BoxFuture<'static, Result<Connected, kube::Error>>;
}

pub(super) struct Kube(pub kube::Client);

impl Connect for Kube {
    fn connect(&self, spec: &Spec) -> BoxFuture<'static, Result<Connected, kube::Error>> {
        let api = Api::<Pod>::namespaced(self.0.clone(), &spec.namespace);
        let spec = spec.clone();
        async move {
            let params = AttachParams {
                container: Some(spec.container.clone()),
                stdin: spec.stdin,
                stdout: true,
                stderr: !spec.tty,
                tty: spec.tty,
                max_stdin_buf_size: Some(FRAME_MAX),
                max_stdout_buf_size: Some(FRAME_MAX),
                max_stderr_buf_size: Some(FRAME_MAX),
            };
            let mut process = match &spec.join {
                Join::Exec(command) => api.exec(&spec.pod, command.clone(), &params).await?,
                Join::Attach => api.attach(&spec.pod, &params).await?,
            };
            let stdout = process.stdout().expect("asked for");
            let stderr = process.stderr();
            let stdin = process.stdin();
            let resize = process.terminal_size();
            let status = process.take_status().expect("taken once").boxed();
            Ok(Connected {
                stdout,
                stderr,
                stdin,
                resize,
                status,
                held: Box::new(process),
            })
        }
        .boxed()
    }
}
