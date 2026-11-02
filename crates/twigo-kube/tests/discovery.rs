use std::collections::{HashMap, HashSet};
use std::convert::Infallible;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http::header::{CONTENT_TYPE, ETAG, IF_NONE_MATCH};
use http::{Request, Response, StatusCode};
use http_body_util::Full;
use kube::client::Body;
use twigo_ipc::{ErrorKind, IpcError, Resource};
use twigo_kube::discovery::{Cache, Discovery, Error};

const AGGREGATED: &str = "application/json;g=apidiscovery.k8s.io;v=v2;as=APIGroupDiscoveryList";
const API_ETAG: &str = "\"4D7E1BED90B364BC86049DD9E636494980AEF65B7F8CFAA267616FA062B514A8A3CC2C2851CC9337B8D28B4C80960E2353DE5E0B152E87CC223E02EA3C5C37AC\"";
const APIS_ETAG: &str = "\"21077F5D721D58B23003DEBE9697128CDC51E65FB353C8032751BEE6143F7FDDB137EBFDC56860351173CA6C5CEFEA06470B863C4E464FB185F1C9C76A4A3CC1\"";

#[derive(Clone)]
struct Answer {
    status: StatusCode,
    content_type: &'static str,
    etag: Option<&'static str>,
    body: &'static [u8],
}

fn aggregated(body: &'static [u8], etag: &'static str) -> Answer {
    Answer {
        status: StatusCode::OK,
        content_type: AGGREGATED,
        etag: Some(etag),
        body,
    }
}

type Asked = (String, Option<String>);

#[derive(Clone)]
struct Server {
    answers: Arc<Mutex<HashMap<&'static str, Answer>>>,
    asked: Arc<Mutex<Vec<Asked>>>,
}

impl Server {
    fn kind() -> Self {
        let answers = HashMap::from([
            (
                "/api",
                aggregated(include_bytes!("fixtures/discovery-api.json"), API_ETAG),
            ),
            (
                "/apis",
                aggregated(include_bytes!("fixtures/discovery-apis.json"), APIS_ETAG),
            ),
        ]);
        Self {
            answers: Arc::new(Mutex::new(answers)),
            asked: Arc::default(),
        }
    }

    fn set(&self, path: &'static str, answer: Answer) {
        self.answers.lock().unwrap().insert(path, answer);
    }

    fn asked(&self) -> Vec<Asked> {
        let mut asked = std::mem::take(&mut *self.asked.lock().unwrap());
        asked.sort();
        asked
    }

    fn client(&self) -> kube::Client {
        let server = self.clone();
        let service = tower::service_fn(move |request: Request<Body>| {
            let server = server.clone();
            async move { Ok::<_, Infallible>(server.answer(&request)) }
        });
        kube::Client::new(service, "default")
    }

    fn answer(&self, request: &Request<Body>) -> Response<Full<Bytes>> {
        let path = request.uri().path().to_owned();
        let if_none_match = request
            .headers()
            .get(IF_NONE_MATCH)
            .map(|value| value.to_str().unwrap().to_owned());
        self.asked
            .lock()
            .unwrap()
            .push((path.clone(), if_none_match.clone()));
        let answer = self.answers.lock().unwrap()[path.as_str()].clone();
        let mut response = Response::builder();
        if let Some(etag) = answer.etag {
            response = response.header(ETAG, etag);
            if if_none_match.as_deref() == Some(etag) {
                return response
                    .status(StatusCode::NOT_MODIFIED)
                    .body(Full::default())
                    .unwrap();
            }
        }
        response
            .status(answer.status)
            .header(CONTENT_TYPE, answer.content_type)
            .body(Full::new(Bytes::from_static(answer.body)))
            .unwrap()
    }
}

fn find<'a>(resources: &'a [Resource], group: &str, resource: &str) -> Option<&'a Resource> {
    resources
        .iter()
        .find(|r| r.gvr.group == group && r.gvr.resource == resource)
}

#[tokio::test]
async fn an_aggregated_answer_lists_every_resource_one_may_list() {
    let server = Server::kind();
    let discovery = Discovery::refresh(&server.client(), None)
        .await
        .unwrap()
        .unwrap();
    let resources = discovery.resources();

    assert_eq!(resources.len(), 76);
    let unique: HashSet<_> = resources
        .iter()
        .map(|r| (&r.gvr.group, &r.gvr.resource))
        .collect();
    assert_eq!(unique.len(), resources.len());
    let pods = find(&resources, "", "pods").unwrap();
    assert_eq!(
        (
            pods.gvr.version.as_str(),
            pods.kind.as_str(),
            pods.singular.as_str()
        ),
        ("v1", "Pod", "pod")
    );
    assert_eq!(pods.short_names, ["po"]);
    assert!(pods.namespaced);
    let hpa = find(&resources, "autoscaling", "horizontalpodautoscalers").unwrap();
    assert_eq!(hpa.gvr.version, "v2");
    let stages = find(&resources, "kwok.x-k8s.io", "stages").unwrap();
    assert_eq!(
        (stages.gvr.version.as_str(), stages.kind.as_str()),
        ("v1alpha1", "Stage")
    );
    assert!(!stages.namespaced);
    assert!(find(&resources, "", "componentstatuses").is_some());
    assert!(find(&resources, "", "bindings").is_none());
    assert!(
        find(
            &resources,
            "authorization.k8s.io",
            "selfsubjectaccessreviews"
        )
        .is_none()
    );
    assert!(resources.iter().all(|r| !r.gvr.resource.contains('/')));
}

#[tokio::test]
async fn the_etags_revalidate_discovery_with_304() {
    let server = Server::kind();
    let client = server.client();
    let first = Discovery::refresh(&client, None).await.unwrap().unwrap();
    assert_eq!(
        server.asked(),
        [("/api".to_owned(), None), ("/apis".to_owned(), None)]
    );

    assert_eq!(
        Discovery::refresh(&client, Some(&first)).await.unwrap(),
        None
    );
    assert_eq!(
        server.asked(),
        [
            ("/api".to_owned(), Some(API_ETAG.to_owned())),
            ("/apis".to_owned(), Some(APIS_ETAG.to_owned()))
        ]
    );
}

#[tokio::test]
async fn a_changed_root_replaces_only_itself() {
    let server = Server::kind();
    let client = server.client();
    let first = Discovery::refresh(&client, None).await.unwrap().unwrap();
    server.set(
        "/apis",
        aggregated(
            include_bytes!("fixtures/discovery-apis.json"),
            "\"changed\"",
        ),
    );

    let second = Discovery::refresh(&client, Some(&first))
        .await
        .unwrap()
        .unwrap();
    assert_ne!(second, first);
    assert_eq!(second.resources(), first.resources());
    server.asked();
    assert_eq!(
        Discovery::refresh(&client, Some(&second)).await.unwrap(),
        None
    );
    assert_eq!(
        server.asked(),
        [
            ("/api".to_owned(), Some(API_ETAG.to_owned())),
            ("/apis".to_owned(), Some("\"changed\"".to_owned()))
        ]
    );
}

#[tokio::test]
async fn a_legacy_answer_fails_saying_so() {
    let server = Server::kind();
    server.set(
        "/apis",
        Answer {
            status: StatusCode::OK,
            content_type: "application/json",
            etag: None,
            body: include_bytes!("fixtures/discovery-apis-legacy.json"),
        },
    );

    let error = Discovery::refresh(&server.client(), None)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, Error::NotAggregated { path: "/apis", content_type } if content_type == "application/json"),
        "{error:?}"
    );
    let error = IpcError::from(&error);
    assert_eq!(error.kind, ErrorKind::Unavailable);
    assert!(
        error
            .message
            .starts_with("the server did not answer aggregated discovery"),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn a_refusal_keeps_the_servers_status() {
    let server = Server::kind();
    server.set(
        "/apis",
        Answer {
            status: StatusCode::FORBIDDEN,
            content_type: "application/json",
            etag: None,
            body: include_bytes!("fixtures/discovery-apis-forbidden.json"),
        },
    );

    let error = Discovery::refresh(&server.client(), None)
        .await
        .unwrap_err();
    assert!(
        matches!(&error, Error::Request(kube::Error::Api(status)) if status.code == 403),
        "{error:?}"
    );
    let error = IpcError::from(&error);
    assert_eq!(error.kind, ErrorKind::Forbidden);
    assert!(
        error
            .message
            .contains("User \"system:anonymous\" cannot get path \"/apis\""),
        "{}",
        error.message
    );
}

#[tokio::test]
async fn the_cache_keeps_discovery_per_cluster() {
    let dir = tempfile::tempdir().unwrap();
    let cache = Cache::new(dir.path().join("discovery"));
    let cluster = "https://127.0.0.1:6443 trusting 0123456789abcdef";
    assert!(cache.load(cluster).unwrap().is_none());
    let discovery = Discovery::refresh(&Server::kind().client(), None)
        .await
        .unwrap()
        .unwrap();

    cache.store(cluster, &discovery).unwrap();
    assert_eq!(cache.load(cluster).unwrap(), Some(discovery));
    assert!(
        cache
            .load("https://127.0.0.1:6443 trusting fedcba9876543210")
            .unwrap()
            .is_none()
    );
    let files: Vec<_> = std::fs::read_dir(dir.path().join("discovery"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .collect();
    assert_eq!(files.len(), 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt as _;
        let mode = std::fs::metadata(&files[0]).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }

    std::fs::write(&files[0], b"{").unwrap();
    assert!(cache.load(cluster).is_err());
}
