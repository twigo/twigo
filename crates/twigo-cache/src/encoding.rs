//! The gzip the API server answers with (ARCHITECTURE 3.2): it compresses
//! a list above 128 KiB and, from 1.37, a streaming list, which it
//! closes as one gzip member at every flush, so a reader must take several
//! members. Decoding lives here rather than in a tower layer: tower-http
//! 0.7.1's decoder reads one member only, and the policy proxy shares the
//! client stack.

use std::io::{self, Read, Write};

use bytes::Bytes;
use flate2::read::MultiGzDecoder as PageDecoder;
use flate2::write::MultiGzDecoder as StreamDecoder;
use futures::stream::BoxStream;
use futures::{AsyncBufRead, StreamExt, TryStreamExt};
use http::HeaderMap;
use http::header::{CONTENT_ENCODING, HeaderValue};
use http_body_util::BodyExt;
use kube::client::Body;

/// The `Accept-Encoding` of a request that decodes what it gets.
pub const GZIP: HeaderValue = HeaderValue::from_static("gzip");

pub fn gzipped(headers: &HeaderMap) -> bool {
    headers
        .get(CONTENT_ENCODING)
        .is_some_and(|encoding| encoding.as_bytes().eq_ignore_ascii_case(b"gzip"))
}

/// The most a body reserves before it is decoded, whatever its last four bytes
/// say: a body that inflates past it grows from there.
const RESERVED_AT_MOST: usize = 64 << 20;

/// A collected body, decoded by the response's `Content-Encoding`.
pub fn page(headers: &HeaderMap, body: Bytes) -> io::Result<Bytes> {
    if !gzipped(headers) {
        return Ok(body);
    }
    Ok(decoded(&body)?.into())
}

/// A body's decoded bytes, in a buffer of the size its last gzip member says it
/// inflates to, which the page keeps as long as it lives: a member ends with
/// its input's size modulo 2^32 ([RFC 1952, 2.3.1](https://www.rfc-editor.org/rfc/rfc1952#section-2.3.1)),
/// which the decoder checks. A body of several members grows the buffer by
/// the rest.
fn decoded(body: &[u8]) -> io::Result<Vec<u8>> {
    let size = body.last_chunk().map_or(0, |size| {
        (u32::from_le_bytes(*size) as usize).min(RESERVED_AT_MOST)
    });
    let mut plain = Vec::with_capacity(size);
    PageDecoder::new(body).read_to_end(&mut plain)?;
    Ok(plain)
}

/// A body read as it arrives, decoded by the response's `Content-Encoding`.
pub fn lines(headers: &HeaderMap, body: Body) -> impl AsyncBufRead + Send + use<> {
    let chunks = body.into_data_stream().map_err(io::Error::other).boxed();
    let chunks = if gzipped(headers) {
        inflate(chunks)
    } else {
        chunks
    };
    chunks.into_async_read()
}

/// Whatever the decoder has out of a chunk comes at once, since the server
/// flushes whenever it has nothing queued and a line must not wait for the
/// next chunk.
fn inflate(chunks: BoxStream<'static, io::Result<Bytes>>) -> BoxStream<'static, io::Result<Bytes>> {
    futures::stream::try_unfold(
        (chunks, StreamDecoder::new(Vec::new())),
        |(mut chunks, mut decoder)| async move {
            while let Some(chunk) = chunks.try_next().await? {
                decoder.write_all(&chunk)?;
                decoder.flush()?;
                let plain = std::mem::take(decoder.get_mut());
                if !plain.is_empty() {
                    return Ok(Some((Bytes::from(plain), (chunks, decoder))));
                }
            }
            Ok(None)
        },
    )
    .boxed()
}

#[cfg(test)]
mod tests {
    use flate2::Compression;
    use flate2::write::GzEncoder;
    use futures::FutureExt;
    use futures::channel::mpsc;

    use super::*;

    fn gzip(text: &str) -> Vec<u8> {
        let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
        encoder.write_all(text.as_bytes()).unwrap();
        encoder.finish().unwrap()
    }

    fn encoded() -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(CONTENT_ENCODING, HeaderValue::from_static("GZIP"));
        headers
    }

    #[test]
    fn a_page_is_decoded_by_its_content_encoding() {
        assert_eq!(page(&HeaderMap::new(), "plain".into()).unwrap(), "plain");
        assert_eq!(page(&encoded(), gzip("page").into()).unwrap(), "page");
        assert!(page(&encoded(), "not gzip".into()).is_err());
    }

    #[test]
    fn a_page_is_held_at_its_own_size() {
        let text = "a page of objects ".repeat(5_000);
        let plain = decoded(&gzip(&text)).unwrap();
        assert_eq!(plain, text.as_bytes());
        assert_eq!(plain.capacity(), plain.len());
    }

    #[test]
    fn a_body_of_several_members_or_one_past_the_reservation_decodes_whole() {
        let mut members = gzip("one, ");
        members.extend(gzip("two"));
        assert_eq!(decoded(&members).unwrap(), b"one, two");

        let past = "\0".repeat(RESERVED_AT_MOST + 1);
        assert_eq!(decoded(&gzip(&past)).unwrap().len(), past.len());
    }

    #[tokio::test]
    async fn a_stream_decodes_each_member_as_it_arrives_cut_anywhere() {
        let (sender, receiver) = mpsc::unbounded::<io::Result<Bytes>>();
        let mut plain = inflate(receiver.boxed());
        for text in ["one\n", "two\nthree\n"] {
            let member = gzip(text);
            let (first, second) = member.split_at(7);
            sender.unbounded_send(Ok(first.to_vec().into())).unwrap();
            assert!(plain.next().now_or_never().is_none(), "half a member");
            sender.unbounded_send(Ok(second.to_vec().into())).unwrap();
            assert_eq!(plain.next().await.unwrap().unwrap(), text);
        }
        drop(sender);
        assert!(plain.next().await.is_none());
    }
}
