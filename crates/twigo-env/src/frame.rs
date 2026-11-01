//! The environment between two markers, so that whatever startup files
//! print around it is left out: `<marker>NAME=value\0…<marker>`, the
//! entries as `env -0` prints them.

use std::collections::BTreeMap;
use std::ffi::{OsStr, OsString};
use std::io::{self, Write};
use std::os::unix::ffi::{OsStrExt, OsStringExt};

pub(crate) type Vars = BTreeMap<OsString, OsString>;

pub(crate) fn write(
    marker: &OsStr,
    vars: impl IntoIterator<Item = (OsString, OsString)>,
    out: &mut impl Write,
) -> io::Result<()> {
    let mut frame = marker.as_bytes().to_vec();
    for (name, value) in vars {
        frame.extend_from_slice(name.as_bytes());
        frame.push(b'=');
        frame.extend_from_slice(value.as_bytes());
        frame.push(0);
    }
    frame.extend_from_slice(marker.as_bytes());
    out.write_all(&frame)?;
    out.flush()
}

/// The environment, once `printed` holds a whole frame.
pub(crate) fn scan(printed: &[u8], marker: &[u8]) -> Option<Vars> {
    let start = find(printed, marker)? + marker.len();
    let end = find(&printed[start..], marker)?;
    Some(parse(&printed[start..start + end]))
}

/// How much of `printed` is the shell's own output: all of it up to where
/// a frame starts, since the frame holds the environment.
pub(crate) fn output_len(printed: &[u8], marker: &[u8]) -> usize {
    find(printed, marker).unwrap_or(printed.len())
}

/// Entries without a `=` after a non-empty name cannot be passed on, so
/// they are dropped.
fn parse(body: &[u8]) -> Vars {
    body.split(|&byte| byte == 0)
        .filter_map(|entry| {
            let at = entry.iter().skip(1).position(|&byte| byte == b'=')? + 1;
            Some((
                OsString::from_vec(entry[..at].to_vec()),
                OsString::from_vec(entry[at + 1..].to_vec()),
            ))
        })
        .collect()
}

fn find(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vars(entries: &[(&str, &str)]) -> Vars {
        entries
            .iter()
            .map(|(name, value)| (OsString::from(name), OsString::from(value)))
            .collect()
    }

    #[test]
    fn a_written_frame_scans_back_with_noise_around_it() {
        let written = vars(&[
            ("PATH", "/usr/bin:/bin"),
            ("MULTI", "a\nb\n"),
            ("EMPTY", ""),
        ]);
        let mut printed = b"Last login: today\n".to_vec();
        write(OsStr::new("m4rk"), written.clone(), &mut printed).expect("write");
        printed.extend_from_slice(b"bye\n");
        assert_eq!(scan(&printed, b"m4rk"), Some(written));
    }

    #[test]
    fn a_value_may_hold_equals_signs() {
        assert_eq!(scan(b"mA=b=c\0mx", b"m"), Some(vars(&[("A", "b=c")])));
    }

    #[test]
    fn entries_without_a_name_and_value_are_dropped() {
        assert_eq!(
            scan(b"mno-equals\0=x\0A=1\0m", b"m"),
            Some(vars(&[("A", "1")]))
        );
    }

    #[test]
    fn output_stops_where_an_unfinished_frame_starts() {
        assert_eq!(scan(b"noise\nm4rkSECRET=1\0", b"m4rk"), None);
        assert_eq!(output_len(b"noise\nm4rkSECRET=1\0", b"m4rk"), 6);
        assert_eq!(output_len(b"noise\n", b"m4rk"), 6);
    }
}
