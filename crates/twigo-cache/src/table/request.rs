use http::header::ACCEPT;
use http::{Request, header::HeaderValue};

/// The plain JSON fallback lets an aggregated API without Table support answer
/// with raw objects instead of 406.
pub const ACCEPT_TABLE: &str = "application/json;as=Table;v=v1;g=meta.k8s.io, application/json";

pub enum WatchFrom<'a> {
    ResourceVersion(&'a str),
    /// A streaming list, ended by a bookmark annotated
    /// `k8s.io/initial-events-end`. Its events are Tables only from 1.34: 1.32
    /// sends raw objects, 1.33 rejects it.
    InitialEvents,
}

pub fn list(path: &str, limit: u32, continue_token: Option<&str>) -> Request<Vec<u8>> {
    let mut query = form_urlencoded::Serializer::new(String::new());
    query.append_pair("includeObject", "Metadata");
    query.append_pair("limit", &limit.to_string());
    if let Some(token) = continue_token {
        query.append_pair("continue", token);
    }
    get(path, query.finish())
}

pub fn watch(path: &str, from: WatchFrom<'_>, timeout_seconds: u32) -> Request<Vec<u8>> {
    let mut query = form_urlencoded::Serializer::new(String::new());
    query.append_pair("watch", "true");
    query.append_pair("allowWatchBookmarks", "true");
    query.append_pair("includeObject", "Metadata");
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
    get(path, query.finish())
}

fn get(path: &str, query: String) -> Request<Vec<u8>> {
    let mut request = Request::new(Vec::new());
    *request.uri_mut() = format!("{path}?{query}")
        .parse()
        .expect("a collection path and an encoded query form a valid URI");
    request
        .headers_mut()
        .insert(ACCEPT, HeaderValue::from_static(ACCEPT_TABLE));
    request
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn list_asks_for_a_table_page() {
        let request = list("/api/v1/pods", 500, Some("abc="));
        assert_eq!(
            request.uri(),
            "/api/v1/pods?includeObject=Metadata&limit=500&continue=abc%3D"
        );
        assert_eq!(request.headers()[ACCEPT], ACCEPT_TABLE);
    }

    #[test]
    fn watch_resumes_or_streams_the_initial_list() {
        assert_eq!(
            watch("/api/v1/pods", WatchFrom::ResourceVersion("42"), 290).uri(),
            "/api/v1/pods?watch=true&allowWatchBookmarks=true&includeObject=Metadata&timeoutSeconds=290&resourceVersion=42"
        );
        assert_eq!(
            watch("/api/v1/pods", WatchFrom::InitialEvents, 290).uri(),
            "/api/v1/pods?watch=true&allowWatchBookmarks=true&includeObject=Metadata&timeoutSeconds=290&sendInitialEvents=true&resourceVersionMatch=NotOlderThan"
        );
    }
}
