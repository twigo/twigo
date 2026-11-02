//! Label selectors, applied in Rust to the labels of each row (ARCHITECTURE
//! 3.2), with the grammar and the checks of apimachinery's `labels.Parse`
//! ([`selector.go`](https://github.com/kubernetes/kubernetes/blob/v1.37.0/staging/src/k8s.io/apimachinery/pkg/labels/selector.go#L463-L947)):
//! `a=b`, `a==b`, `a!=b`, `a in (b,c)`, `a notin (b)`, `a`, `!a`, `a>1`,
//! `a<1`, joined by commas. A NUL byte, where Go's lexer stops reading as at
//! the end of the input, is refused as part of a key or a value.

use twigo_ipc::{ErrorKind, IpcError};

use crate::meta::Labels;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selector(Vec<Requirement>);

#[derive(Debug, Clone, PartialEq, Eq)]
struct Requirement {
    key: String,
    op: Op,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Op {
    In(Vec<String>),
    NotIn(Vec<String>),
    Exists,
    DoesNotExist,
    GreaterThan(i64),
    LessThan(i64),
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Token {
    End,
    ClosedPar,
    Comma,
    DoesNotExist,
    DoubleEquals,
    Equals,
    GreaterThan,
    In,
    LessThan,
    NotEquals,
    NotIn,
    OpenPar,
    Identifier(String),
}

fn special(c: u8) -> bool {
    matches!(c, b'=' | b'!' | b'(' | b')' | b',' | b'>' | b'<')
}

fn whitespace(c: u8) -> bool {
    matches!(c, b' ' | b'\t' | b'\r' | b'\n')
}

fn keyword(text: &str) -> Option<Token> {
    Some(match text {
        ")" => Token::ClosedPar,
        "," => Token::Comma,
        "!" => Token::DoesNotExist,
        "==" => Token::DoubleEquals,
        "=" => Token::Equals,
        ">" => Token::GreaterThan,
        "in" => Token::In,
        "<" => Token::LessThan,
        "!=" => Token::NotEquals,
        "notin" => Token::NotIn,
        "(" => Token::OpenPar,
        _ => return None,
    })
}

fn invalid(message: String) -> IpcError {
    IpcError {
        kind: ErrorKind::InvalidInput,
        message: format!("the label selector: {message}"),
    }
}

fn lex(source: &str) -> Result<Vec<Token>, IpcError> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    let mut at = 0;
    loop {
        while at < bytes.len() && whitespace(bytes[at]) {
            at += 1;
        }
        if at == bytes.len() {
            tokens.push(Token::End);
            return Ok(tokens);
        }
        let start = at;
        if special(bytes[at]) {
            // `!=` and `==` are the only operators of two symbols.
            let (token, length) = match source.get(at..at + 2).and_then(keyword) {
                Some(token) => (token, 2),
                None => (
                    keyword(&source[at..=at]).expect("each special symbol is a token"),
                    1,
                ),
            };
            tokens.push(token);
            at += length;
        } else {
            while at < bytes.len() && !special(bytes[at]) && !whitespace(bytes[at]) {
                at += 1;
            }
            let text = &source[start..at];
            tokens.push(keyword(text).unwrap_or_else(|| Token::Identifier(text.to_owned())));
        }
    }
}

struct Parser {
    tokens: Vec<Token>,
    at: usize,
}

impl Parser {
    /// The next token; `in` and `notin` are identifiers where values go.
    fn peek(&self, values: bool) -> Token {
        let token = self.tokens[self.at].clone();
        match token {
            Token::In if values => Token::Identifier("in".to_owned()),
            Token::NotIn if values => Token::Identifier("notin".to_owned()),
            token => token,
        }
    }

    fn next(&mut self, values: bool) -> Token {
        let token = self.peek(values);
        self.at += 1;
        token
    }

    fn selector(&mut self) -> Result<Vec<Requirement>, IpcError> {
        let mut requirements = Vec::new();
        loop {
            match self.peek(true) {
                Token::Identifier(_) | Token::DoesNotExist => {
                    requirements.push(self.requirement()?);
                    match self.next(true) {
                        Token::End => return Ok(requirements),
                        Token::Comma => {
                            if !matches!(
                                self.peek(true),
                                Token::Identifier(_) | Token::DoesNotExist
                            ) {
                                return Err(invalid("expected a key after ','".to_owned()));
                            }
                        }
                        token => {
                            return Err(invalid(format!("found {token:?}, expected ','")));
                        }
                    }
                }
                Token::End => return Ok(requirements),
                token => return Err(invalid(format!("found {token:?}, expected a key"))),
            }
        }
    }

    fn requirement(&mut self) -> Result<Requirement, IpcError> {
        let mut absent = false;
        let mut token = self.next(true);
        if token == Token::DoesNotExist {
            absent = true;
            token = self.next(true);
        }
        let Token::Identifier(key) = token else {
            return Err(invalid(format!("found {token:?}, expected a key")));
        };
        check_key(&key)?;
        // `!a=b` leaves `=b` for the selector to refuse, as apimachinery's
        // parser does.
        if absent {
            return Ok(Requirement {
                key,
                op: Op::DoesNotExist,
            });
        }
        if matches!(self.peek(true), Token::End | Token::Comma) {
            return Ok(Requirement {
                key,
                op: Op::Exists,
            });
        }
        let op = match self.next(false) {
            Token::In => Op::In(self.set()?),
            Token::NotIn => Op::NotIn(self.set()?),
            Token::Equals | Token::DoubleEquals => Op::In(vec![self.exact()?]),
            Token::NotEquals => Op::NotIn(vec![self.exact()?]),
            Token::GreaterThan => Op::GreaterThan(integer(&self.exact()?)?),
            Token::LessThan => Op::LessThan(integer(&self.exact()?)?),
            token => {
                return Err(invalid(format!(
                    "found {token:?}, expected an operator after {key}"
                )));
            }
        };
        Ok(Requirement { key, op })
    }

    /// `(a,b,c)`; empty values count, as in `(a,,b)`.
    fn set(&mut self) -> Result<Vec<String>, IpcError> {
        if self.next(true) != Token::OpenPar {
            return Err(invalid("expected '('".to_owned()));
        }
        let mut values = Vec::new();
        let mut expect_value = true;
        loop {
            match self.next(true) {
                Token::Identifier(value) if expect_value => {
                    check_value(&value)?;
                    values.push(value);
                    expect_value = false;
                }
                Token::Comma => {
                    if expect_value {
                        values.push(String::new());
                    }
                    expect_value = true;
                }
                Token::ClosedPar => {
                    if expect_value {
                        values.push(String::new());
                    }
                    values.sort();
                    values.dedup();
                    return Ok(values);
                }
                token => return Err(invalid(format!("found {token:?}, expected ',' or ')'"))),
            }
        }
    }

    /// One value, empty before a comma or the end.
    fn exact(&mut self) -> Result<String, IpcError> {
        if matches!(self.peek(true), Token::End | Token::Comma) {
            return Ok(String::new());
        }
        match self.next(true) {
            Token::Identifier(value) => {
                check_value(&value)?;
                Ok(value)
            }
            token => Err(invalid(format!("found {token:?}, expected a value"))),
        }
    }
}

fn integer(value: &str) -> Result<i64, IpcError> {
    value
        .parse()
        .map_err(|_| invalid(format!("{value:?} is no integer, which > and < compare")))
}

/// A name part: at most 63 alphanumerics, `-`, `_` and `.`, beginning and
/// ending with an alphanumeric.
fn name_part(name: &str) -> bool {
    let bytes = name.as_bytes();
    let edge = |b: &u8| b.is_ascii_alphanumeric();
    !bytes.is_empty()
        && bytes.len() <= 63
        && bytes.first().is_some_and(edge)
        && bytes.last().is_some_and(edge)
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
}

/// A DNS-1123 subdomain: at most 253 characters, lower-case labels of
/// alphanumerics and `-` joined by dots.
fn subdomain(prefix: &str) -> bool {
    prefix.len() <= 253
        && prefix.split('.').all(|label| {
            let bytes = label.as_bytes();
            let edge = |b: &u8| b.is_ascii_lowercase() || b.is_ascii_digit();
            bytes.first().is_some_and(edge)
                && bytes.last().is_some_and(edge)
                && bytes
                    .iter()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
        })
}

fn check_key(key: &str) -> Result<(), IpcError> {
    let valid = match key.split_once('/') {
        Some((prefix, name)) => subdomain(prefix) && name_part(name),
        None => name_part(key),
    };
    if valid {
        Ok(())
    } else {
        Err(invalid(format!("{key:?} is no label key")))
    }
}

fn check_value(value: &str) -> Result<(), IpcError> {
    if value.is_empty() || name_part(value) {
        Ok(())
    } else {
        Err(invalid(format!("{value:?} is no label value")))
    }
}

impl Selector {
    pub fn parse(source: &str) -> Result<Self, IpcError> {
        let mut parser = Parser {
            tokens: lex(source)?,
            at: 0,
        };
        Ok(Self(parser.selector()?))
    }

    pub fn matches(&self, labels: &Labels) -> bool {
        let get = |key: &str| {
            labels
                .iter()
                .find(|(name, _)| &**name == key)
                .map(|(_, value)| &**value)
        };
        self.0.iter().all(|requirement| {
            let value = get(&requirement.key);
            match &requirement.op {
                Op::In(values) => value.is_some_and(|v| values.iter().any(|w| w == v)),
                Op::NotIn(values) => value.is_none_or(|v| values.iter().all(|w| w != v)),
                Op::Exists => value.is_some(),
                Op::DoesNotExist => value.is_none(),
                Op::GreaterThan(bound) => value
                    .and_then(|v| v.parse::<i64>().ok())
                    .is_some_and(|v| v > *bound),
                Op::LessThan(bound) => value
                    .and_then(|v| v.parse::<i64>().ok())
                    .is_some_and(|v| v < *bound),
            }
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels(pairs: &[(&str, &str)]) -> Labels {
        pairs
            .iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect()
    }

    fn matches(selector: &str, pairs: &[(&str, &str)]) -> bool {
        Selector::parse(selector).unwrap().matches(&labels(pairs))
    }

    #[test]
    fn equality_and_inequality() {
        assert!(matches("app=web", &[("app", "web")]));
        assert!(matches("app==web", &[("app", "web")]));
        assert!(!matches("app=web", &[("app", "db")]));
        assert!(matches("app!=web", &[("app", "db")]));
        assert!(matches("app!=web", &[]), "a missing key is not equal");
        assert!(matches("app=", &[("app", "")]), "the empty value");
    }

    #[test]
    fn sets_with_prefixed_keys_and_digits() {
        let pairs = [("app.kubernetes.io/name", "v2")];
        assert!(matches("app.kubernetes.io/name in (v1, v2)", &pairs));
        assert!(!matches("app.kubernetes.io/name notin (v1,v2)", &pairs));
        assert!(
            matches("tier notin (web)", &pairs),
            "a missing key is not in"
        );
        assert!(matches("x in (,a)", &[("x", "")]), "empty values count");
        assert!(
            matches("x in (in, notin)", &[("x", "notin")]),
            "keywords as values"
        );
    }

    #[test]
    fn existence_and_comparisons() {
        assert!(matches("app", &[("app", "web")]));
        assert!(!matches("!app", &[("app", "web")]));
        assert!(matches("!app,tier", &[("tier", "a")]));
        assert!(matches("gen>2", &[("gen", "3")]));
        assert!(!matches("gen<2", &[("gen", "x")]));
        assert!(matches("", &[]), "an empty selector selects everything");
    }

    #[test]
    fn what_apimachinery_refuses_is_invalid_input() {
        for selector in [
            "app=web,",
            "app in web",
            "app in (web",
            "=web",
            "app=web=db",
            "app=-web",
            "Prefix.IO/app=web",
            "app>x",
            "a b",
            "!app=web",
        ] {
            let error = Selector::parse(selector).unwrap_err();
            assert_eq!(error.kind, ErrorKind::InvalidInput, "{selector}");
        }
    }
}
