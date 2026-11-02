//! The list and watch requests of an upstream's collection, in the form its
//! kind asks for (ARCHITECTURE 3.3).

use http::header::ACCEPT;
use http::{Request, header::HeaderValue};

/// The plain JSON fallback lets a server that does not implement Table
/// answer with raw objects instead of 406.
pub const ACCEPT_TABLE: &str = "application/json;as=Table;v=v1;g=meta.k8s.io, application/json";
/// kube's own (`kube-core` 4.2, `request.rs`), with the same fallback: a
/// server without metadata answers with the full objects.
const ACCEPT_METADATA_LIST: &str =
    "application/json;as=PartialObjectMetadataList;g=meta.k8s.io;v=v1, application/json";
const ACCEPT_METADATA: &str =
    "application/json;as=PartialObjectMetadata;g=meta.k8s.io;v=v1, application/json";
const ACCEPT_OBJECT: &str = "application/json";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Format {
    /// Rows with the server's columns and the object's metadata.
    Table,
    /// The objects' metadata.
    Metadata,
    /// Whole objects.
    Object,
}

/// A collection as an upstream watches it.
#[derive(Debug, Clone, Copy)]
pub struct Collection<'a> {
    /// Such as `/api/v1/namespaces/default/pods`.
    pub path: &'a str,
    pub format: Format,
    pub field_selector: Option<&'a str>,
}

impl<'a> Collection<'a> {
    pub fn table(path: &'a str) -> Self {
        Collection {
            path,
            format: Format::Table,
            field_selector: None,
        }
    }

    fn query(&self) -> form_urlencoded::Serializer<'static, String> {
        let mut query = form_urlencoded::Serializer::new(String::new());
        if self.format == Format::Table {
            query.append_pair("includeObject", "Metadata");
        }
        if let Some(selector) = self.field_selector {
            query.append_pair("fieldSelector", selector);
        }
        query
    }
}

pub enum WatchFrom<'a> {
    ResourceVersion(&'a str),
    /// A streaming list, ended by a bookmark annotated
    /// `k8s.io/initial-events-end`. 1.33 rejects it: its WatchList gate is off.
    InitialEvents,
}

pub fn list(
    collection: &Collection<'_>,
    limit: u32,
    continue_token: Option<&str>,
) -> Request<Vec<u8>> {
    let mut query = collection.query();
    query.append_pair("limit", &limit.to_string());
    if let Some(token) = continue_token {
        query.append_pair("continue", token);
    }
    let accept = match collection.format {
        Format::Table => ACCEPT_TABLE,
        Format::Metadata => ACCEPT_METADATA_LIST,
        Format::Object => ACCEPT_OBJECT,
    };
    get(collection.path, query.finish(), accept)
}

pub fn watch(
    collection: &Collection<'_>,
    from: WatchFrom<'_>,
    timeout_seconds: u32,
) -> Request<Vec<u8>> {
    let mut query = collection.query();
    query.append_pair("watch", "true");
    query.append_pair("allowWatchBookmarks", "true");
    query.append_pair("timeoutSeconds", &timeout_seconds.to_string());
    match from {
        WatchFrom::ResourceVersion(version) => {
            query.append_pair("resourceVersion", version);
        }
        WatchFrom::InitialEvents => {
            query.append_pair("sendInitialEvents", "true");
            query.append_pair("resourceVersionMatch", "NotOlderThan");
        }
    }
    let accept = match collection.format {
        Format::Table => ACCEPT_TABLE,
        Format::Metadata => ACCEPT_METADATA,
        Format::Object => ACCEPT_OBJECT,
    };
    get(collection.path, query.finish(), accept)
}

fn get(path: &str, query: String, accept: &'static str) -> Request<Vec<u8>> {
    let mut request = Request::new(Vec::new());
    *request.uri_mut() = format!("{path}?{query}")
        .parse()
        .expect("a collection path and an encoded query form a valid URI");
    request
        .headers_mut()
        .insert(ACCEPT, HeaderValue::from_static(accept));
    request
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_asks_for_a_table_page() {
        let request = list(&Collection::table("/api/v1/pods"), 500, Some("abc="));
        assert_eq!(
            request.uri(),
            "/api/v1/pods?includeObject=Metadata&limit=500&continue=abc%3D"
        );
        assert_eq!(request.headers()[ACCEPT], ACCEPT_TABLE);
    }

    #[test]
    fn watch_resumes_or_streams_the_initial_list() {
        assert_eq!(
            watch(
                &Collection::table("/api/v1/pods"),
                WatchFrom::ResourceVersion("42"),
                290
            )
            .uri(),
            "/api/v1/pods?includeObject=Metadata&watch=true&allowWatchBookmarks=true&timeoutSeconds=290&resourceVersion=42"
        );
        assert_eq!(
            watch(
                &Collection::table("/api/v1/pods"),
                WatchFrom::InitialEvents,
                290
            )
            .uri(),
            "/api/v1/pods?includeObject=Metadata&watch=true&allowWatchBookmarks=true&timeoutSeconds=290&sendInitialEvents=true&resourceVersionMatch=NotOlderThan"
        );
    }

    #[test]
    fn metadata_and_objects_ask_for_their_own_forms() {
        let namespaces = Collection {
            path: "/api/v1/namespaces",
            format: Format::Metadata,
            field_selector: None,
        };
        assert_eq!(
            list(&namespaces, 500, None).headers()[ACCEPT],
            ACCEPT_METADATA_LIST
        );
        assert_eq!(
            watch(&namespaces, WatchFrom::ResourceVersion("7"), 290).headers()[ACCEPT],
            ACCEPT_METADATA
        );
        let pod = Collection {
            path: "/api/v1/namespaces/a/pods",
            format: Format::Object,
            field_selector: Some("metadata.name=p"),
        };
        let request = watch(&pod, WatchFrom::ResourceVersion("7"), 290);
        assert_eq!(
            request.uri(),
            "/api/v1/namespaces/a/pods?fieldSelector=metadata.name%3Dp&watch=true&allowWatchBookmarks=true&timeoutSeconds=290&resourceVersion=7"
        );
        assert_eq!(request.headers()[ACCEPT], ACCEPT_OBJECT);
    }
}
