//! The proxy a context's clients go through, picked as kubectl picks it
//! (ARCHITECTURE 6.3): the cluster's `proxy-url` for every request; else
//! the login shell's `HTTPS_PROXY` or `HTTP_PROXY`, unless the API server is
//! loopback or `NO_PROXY` lists it.
//!
//! client-go validates `proxy-url` in `clientcmd/validation.go` and hands
//! the environment to Go's `http.ProxyFromEnvironment`. Its rules, ported
//! here from `golang.org/x/net/http/httpproxy` as Go's net/http vendors it, differ
//! from curl's, which hyper-util's matcher follows: loopback is never
//! proxied, `.x` and `*.x` match only subdomains, and entries may carry a
//! port. hyper-util's matcher only parses the proxy's URL here.

use std::net::IpAddr;

use http::Uri;
use hyper_util::client::proxy::matcher::{Intercept, Matcher};
use ipnet::IpNet;

#[derive(Clone)]
pub struct Proxy(Intercept);

impl Proxy {
    pub fn uri(&self) -> &Uri {
        self.0.uri()
    }

    pub(super) fn intercept(&self) -> &Intercept {
        &self.0
    }

    /// Go dials socks5h as socks5, whose names the proxy resolves.
    pub(super) fn is_socks(&self) -> bool {
        matches!(self.uri().scheme_str(), Some("socks5" | "socks5h"))
    }
}

impl std::fmt::Debug for Proxy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Not the credentials it may carry.
        f.debug_tuple("Proxy").field(self.uri()).finish()
    }
}

#[derive(Debug, thiserror::Error)]
#[error("proxy-url {0:?} is not an http, https or socks5 URL")]
pub struct ProxyError(String);

/// The proxy variables of the login shell's environment.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProxyEnv {
    https: Option<String>,
    http: Option<String>,
    no: String,
}

impl ProxyEnv {
    /// Go's `httpproxy.FromEnvironment`: the first of each pair that is set
    /// and not empty.
    pub fn from_vars(var: impl Fn(&str) -> Option<String>) -> Self {
        let any = |names: [&str; 2]| {
            names
                .into_iter()
                .find_map(|name| var(name).filter(|value| !value.is_empty()))
        };
        Self {
            https: any(["HTTPS_PROXY", "https_proxy"]),
            http: any(["HTTP_PROXY", "http_proxy"]),
            no: any(["NO_PROXY", "no_proxy"]).unwrap_or_default(),
        }
    }
}

/// The proxy for the API server at `server`, from the cluster's `proxy-url`
/// or the environment.
pub fn proxy_for(
    server: &Uri,
    proxy_url: Option<&str>,
    env: &ProxyEnv,
) -> Result<Option<Proxy>, ProxyError> {
    if let Some(url) = proxy_url.filter(|url| !url.is_empty()) {
        // hyper-util takes a URL without a scheme for http; client-go does
        // not.
        let named = url.split_once("://").map(|(scheme, _)| scheme);
        return match parse(url, server) {
            Some(proxy) if matches!(named, Some("http" | "https" | "socks5")) => {
                Ok(Some(Proxy(proxy)))
            }
            _ => Err(ProxyError(url.to_owned())),
        };
    }
    let value = match server.scheme_str() {
        Some("https") => &env.https,
        Some("http") => &env.http,
        _ => return Ok(None),
    };
    let Some(value) = value else {
        return Ok(None);
    };
    // Go's transport dials a proxy of any scheme but socks5 as an HTTP one,
    // and ignores a value it cannot parse.
    let value = match value.split_once("://") {
        Some((scheme, rest)) if !matches!(scheme, "http" | "https" | "socks5" | "socks5h") => {
            format!("http://{rest}")
        }
        _ => value.clone(),
    };
    let Some(proxy) = parse(&value, server) else {
        return Ok(None);
    };
    let host = server.host().unwrap_or_default();
    let port = server
        .port_u16()
        .unwrap_or(if server.scheme_str() == Some("https") {
            443
        } else {
            80
        });
    Ok(NoProxy::parse(&env.no)
        .proxies(host, port)
        .then_some(Proxy(proxy)))
}

/// A proxy URL, `http://` when it has no scheme, its credentials split off.
fn parse(url: &str, server: &Uri) -> Option<Intercept> {
    Matcher::builder().all(url).build().intercept(server)
}

/// Go's NO_PROXY rules.
#[derive(Debug, Default)]
struct NoProxy {
    all: bool,
    ips: Vec<IpEntry>,
    domains: Vec<DomainEntry>,
}

#[derive(Debug)]
enum IpEntry {
    Net(IpNet),
    Addr(IpAddr, String),
}

#[derive(Debug)]
struct DomainEntry {
    /// With its leading dot.
    suffix: String,
    port: String,
    /// Whether the entry matches the domain itself, not only its
    /// subdomains.
    exact: bool,
}

impl NoProxy {
    fn parse(list: &str) -> Self {
        let mut no = Self::default();
        for entry in list.split(',') {
            let entry = entry.trim().to_lowercase();
            if entry.is_empty() {
                continue;
            }
            if entry == "*" {
                no.all = true;
                return no;
            }
            if let Ok(net) = entry.parse::<IpNet>() {
                no.ips.push(IpEntry::Net(net));
                continue;
            }
            let (host, port) = match split_host_port(&entry) {
                Some(("", _)) => continue,
                Some((host, port)) => (host, port.to_owned()),
                None => (entry.as_str(), String::new()),
            };
            if let Ok(ip) = host.parse::<IpAddr>() {
                no.ips.push(IpEntry::Addr(ip.to_canonical(), port));
                continue;
            }
            let host = host
                .strip_prefix('*')
                .filter(|rest| rest.starts_with('.'))
                .unwrap_or(host);
            let exact = !host.starts_with('.');
            no.domains.push(DomainEntry {
                suffix: if exact {
                    format!(".{host}")
                } else {
                    host.to_owned()
                },
                port,
                exact,
            });
        }
        no
    }

    /// Go's `useProxy`.
    fn proxies(&self, host: &str, port: u16) -> bool {
        let host = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host);
        // Before lowercasing, as Go compares it.
        if host == "localhost" {
            return false;
        }
        let ip = host.parse::<IpAddr>().ok().map(|ip| ip.to_canonical());
        if ip.is_some_and(|ip| ip.is_loopback()) {
            return false;
        }
        if self.all {
            return false;
        }
        let port = port.to_string();
        // An entry without a port matches every port.
        let on_port = |entry: &str| entry.is_empty() || entry == port;
        if let Some(ip) = ip {
            return !self.ips.iter().any(|entry| match entry {
                IpEntry::Net(net) => net.contains(&ip),
                IpEntry::Addr(addr, entry) => *addr == ip && on_port(entry),
            });
        }
        let host = host.to_lowercase();
        !self.domains.iter().any(|entry| {
            (host.ends_with(&entry.suffix) || (entry.exact && host == entry.suffix[1..]))
                && on_port(&entry.port)
        })
    }
}

/// Go's `net.SplitHostPort`: `host:port` or `[host]:port`; None for a bare
/// host or an IPv6 address without brackets.
fn split_host_port(entry: &str) -> Option<(&str, &str)> {
    if let Some(rest) = entry.strip_prefix('[') {
        let (host, rest) = rest.split_once(']')?;
        return Some((host, rest.strip_prefix(':')?));
    }
    let (host, port) = entry.split_once(':')?;
    (!port.contains(':')).then_some((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(https: &str, no: &str) -> ProxyEnv {
        ProxyEnv::from_vars(|name| match name {
            "HTTPS_PROXY" => Some(https.to_owned()),
            "HTTP_PROXY" => Some("http://plain.corp:3128".to_owned()),
            "NO_PROXY" => Some(no.to_owned()),
            _ => None,
        })
    }

    fn pick(server: &str, no: &str) -> String {
        let env = env("http://proxy.corp:3128", no);
        match proxy_for(&server.parse().unwrap(), None, &env).unwrap() {
            Some(proxy) => format!("PROXY {}", proxy.uri().authority().unwrap()),
            None => "DIRECT".to_owned(),
        }
    }

    /// Go 1.27.1's `http.ProxyFromEnvironment` printed the third column, with
    /// `HTTPS_PROXY=http://proxy.corp:3128`, `HTTP_PROXY=http://plain.corp:3128`
    /// and the second as `NO_PROXY`.
    const GO: &str = "\
https://127.0.0.1:6443||DIRECT
https://127.1.2.3:6443||DIRECT
https://localhost:6443||DIRECT
https://LOCALHOST:6443||PROXY proxy.corp:3128
https://[::1]:6443||DIRECT
https://[::ffff:127.0.0.1]:6443||DIRECT
https://kind.localhost:6443||PROXY proxy.corp:3128
https://example.com||PROXY proxy.corp:3128
https://example.com|example.com|DIRECT
https://EXAMPLE.com|example.com|DIRECT
https://example.com|.example.com|PROXY proxy.corp:3128
https://api.example.com|.example.com|DIRECT
https://api.example.com|*.example.com|DIRECT
https://example.com|*.example.com|PROXY proxy.corp:3128
https://api.example.com|example.com|DIRECT
https://apiexample.com|example.com|PROXY proxy.corp:3128
https://api.example.com| Example.COM |DIRECT
https://api.example.com:6443|api.example.com:6443|DIRECT
https://api.example.com:6443|api.example.com:443|PROXY proxy.corp:3128
https://api.example.com|api.example.com:443|DIRECT
https://10.0.0.5:6443|10.0.0.5:6443|DIRECT
https://10.0.0.5:6443|10.0.0.5:443|PROXY proxy.corp:3128
https://10.0.0.5:6443|10.0.0.5|DIRECT
https://10.0.0.5:6443|*|DIRECT
https://api.example.com|*|DIRECT
https://10.0.0.5:6443|10.0.0.0/8|DIRECT
https://10.0.0.5:6443|10.0.0.5/8|DIRECT
https://11.0.0.5:6443|10.0.0.0/8|PROXY proxy.corp:3128
https://api.example.com|foo,*|DIRECT
https://10.0.0.5:6443|example.com|PROXY proxy.corp:3128
https://[fd00::5]:6443|fd00::/8|DIRECT
https://[fd00::5]:6443|fd00::5|DIRECT
https://[fd00::5]:6443|[fd00::5]:6443|DIRECT
https://[fd00::5]:6443|[fd00::5]:443|PROXY proxy.corp:3128
https://[::ffff:10.0.0.5]:6443|10.0.0.0/8|DIRECT
https://[::ffff:10.0.0.5]:6443|10.0.0.5|DIRECT
https://api.example.com|,, ,example.com|DIRECT
https://api.example.com|:6443|PROXY proxy.corp:3128
https://api.example.com|[]:6443|PROXY proxy.corp:3128
https://api.example.com:6443|.example.com:6443|DIRECT
https://api.example.com:6443|*.example.com:6443|DIRECT
http://api.example.com|example.org|PROXY plain.corp:3128
http://api.example.com:80|api.example.com:80|DIRECT
https://api.example.com|api.example.com:abc|PROXY proxy.corp:3128
https://api.example.com|api.example.com:|DIRECT
https://api.example.com|*example.com|PROXY proxy.corp:3128
https://10.0.0.5:6443|[10.0.0.5]:6443|DIRECT";

    #[test]
    fn no_proxy_follows_go() {
        for line in GO.lines() {
            let [server, no, go] = line.split('|').collect::<Vec<_>>()[..] else {
                panic!("{line}");
            };
            assert_eq!(pick(server, no), go, "{server} with NO_PROXY={no:?}");
        }
    }

    #[test]
    fn the_environment_takes_the_first_value_set() {
        let env = ProxyEnv::from_vars(|name| match name {
            "HTTPS_PROXY" => Some(String::new()),
            "https_proxy" => Some("http://lower:1".to_owned()),
            "ALL_PROXY" => Some("http://all:1".to_owned()),
            _ => None,
        });
        let server = "https://api.example.com".parse().unwrap();
        let proxy = proxy_for(&server, None, &env).unwrap().unwrap();
        assert_eq!(proxy.uri(), "http://lower:1/");

        let only_http =
            ProxyEnv::from_vars(|name| (name == "HTTP_PROXY").then(|| "http://plain:1".to_owned()));
        assert!(proxy_for(&server, None, &only_http).unwrap().is_none());
    }

    #[test]
    fn proxy_values() {
        let server: Uri = "https://api.example.com".parse().unwrap();
        let pick = |value: &str| proxy_for(&server, None, &env(value, ""));
        assert_eq!(
            pick("proxy.corp:3128").unwrap().unwrap().uri(),
            "http://proxy.corp:3128/"
        );
        let socks = pick("socks5h://user:p%40ss@s:1080").unwrap().unwrap();
        assert!(socks.is_socks());
        assert_eq!(socks.intercept().raw_auth(), Some(("user", "p@ss")));
        let http = pick("http://user:p%40ss@proxy:1").unwrap().unwrap();
        assert_eq!(http.intercept().basic_auth().unwrap(), "Basic dXNlcjpwQHNz");
        assert_eq!(pick("ftp://f:1").unwrap().unwrap().uri(), "http://f:1/");
    }

    #[test]
    fn proxy_url_goes_for_every_server() {
        let env = env("http://proxy.corp:3128", "*");
        let kind = "https://127.0.0.1:6443".parse().unwrap();
        let proxy = proxy_for(&kind, Some("socks5://s:1080"), &env)
            .unwrap()
            .unwrap();
        assert!(proxy.is_socks());
        assert!(proxy_for(&kind, Some(""), &env).unwrap().is_none());
        for refused in ["socks5h://s:1080", "proxy.corp:3128"] {
            assert!(proxy_for(&kind, Some(refused), &env).is_err(), "{refused}");
        }
    }
}
