//! The last lines of the diagnostics log, read from its files and written as
//! text with what a report hides left out, and the place of the last panic.

use std::fs::File;
use std::io::{self, BufRead as _, BufReader, Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};

use serde_json::Value;

use super::redact::{Kind, Redactor};

const LINES: usize = 200;

const BYTES: usize = 32 << 10;

/// The newest lines of the files, each file named newest first, as far as
/// [`LINES`] and [`BYTES`] allow, oldest first. A file that is not there is
/// the log of no run, which is not an error.
pub(super) fn tail(files: &[PathBuf]) -> Vec<String> {
    let mut newest_first = Vec::new();
    let mut bytes = 0;
    'files: for file in files {
        let Ok((lines, cut)) = read_tail(file, BYTES - bytes) else {
            continue;
        };
        for line in lines.into_iter().rev() {
            if newest_first.len() == LINES || bytes + line.len() + 1 > BYTES {
                break 'files;
            }
            bytes += line.len() + 1;
            newest_first.push(line);
        }
        // A file read from its middle leaves a gap before it, which the lines
        // of an older file would not fill.
        if cut {
            break;
        }
    }
    newest_first.reverse();
    newest_first
}

/// The lines in the last `max` bytes of the file, whole ones only, and
/// whether there is more before them.
fn read_tail(path: &Path, max: usize) -> io::Result<(Vec<String>, bool)> {
    let mut file = File::open(path)?;
    let start = file.metadata()?.len().saturating_sub(max as u64);
    file.seek(SeekFrom::Start(start))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)?;
    let text = String::from_utf8_lossy(&bytes);
    let whole = if start == 0 {
        &text[..]
    } else {
        text.split_once('\n').map_or("", |(_, rest)| rest)
    };
    let lines = whole
        .lines()
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect();
    Ok((lines, start > 0))
}

/// Where the newest panic of the files was, and whether it was in the run
/// that wrote the newest of them. The files are named newest first.
pub(super) struct Panic {
    pub location: String,
    pub this_run: bool,
}

pub(super) fn last_panic(files: &[PathBuf]) -> Option<Panic> {
    let mut run = 0;
    let mut last = None;
    for file in files.iter().rev() {
        let Ok(file) = File::open(file) else {
            continue;
        };
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            if line.contains(STARTED) {
                let record: Value = serde_json::from_str(&line).unwrap_or_default();
                if record["fields"]["message"] == STARTED {
                    run += 1;
                }
            } else if line.contains("panic")
                && let Ok(record) = serde_json::from_str::<Value>(&line)
                && let Some(location) = twigo_log::panic_location(&record)
            {
                last = Some((location.to_owned(), run));
            }
        }
    }
    last.map(|(location, panicked_in)| Panic {
        location,
        this_run: panicked_in == run,
    })
}

const STARTED: &str = "Twigo started";

/// The writer writes only JSON objects, so a line that is not one was cut by
/// a full disk, a kill or a power loss, and its fields would be hidden by
/// their quotes alone, which one unbalanced quote shifts.
const NOT_A_RECORD: &str = "<a line that is not a record>";

struct Record {
    time: String,
    level: String,
    target: String,
    message: String,
    fields: Vec<(String, Value)>,
}

impl Record {
    fn parse(line: &str) -> Option<Self> {
        let Ok(Value::Object(mut record)) = serde_json::from_str(line) else {
            return None;
        };
        let mut text = |name: &str| match record.remove(name) {
            Some(Value::String(text)) => text,
            _ => String::new(),
        };
        let (time, level, target) = (text("timestamp"), text("level"), text("target"));
        let mut fields = match record.remove("fields") {
            Some(Value::Object(fields)) => fields,
            _ => serde_json::Map::new(),
        };
        let message = match fields.remove("message") {
            Some(Value::String(message)) => message,
            _ => String::new(),
        };
        Some(Self {
            time,
            level,
            target,
            message,
            fields: fields.into_iter().collect(),
        })
    }

    fn learned(&self) -> impl Iterator<Item = (Kind, String)> {
        self.fields
            .iter()
            .filter_map(|(name, value)| Some((Kind::of_field(name)?, value.as_str()?.to_owned())))
    }
}

/// `lines` as text, one record each, with what `known` and the lines' own
/// fields name, and what the fixed patterns match, hidden, and how much of
/// each kind.
///
/// A record is `<time> <LEVEL> <target> <message> <field>=<value>…`; a value
/// of several lines follows it as a block.
pub(super) fn render(lines: &[String], known: super::redact::Known) -> (String, twigo_ipc::Hidden) {
    let records: Vec<Option<Record>> = lines.iter().map(|line| Record::parse(line)).collect();
    let mut redactor = Redactor::new(known, records.iter().flatten().flat_map(Record::learned));
    let mut text = String::new();
    let mut not_records = 0;
    for record in &records {
        if let Some(record) = record {
            write_record(&mut text, record, &mut redactor);
        } else {
            text.push_str(NOT_A_RECORD);
            text.push('\n');
            not_records += 1;
        }
    }
    let hidden = twigo_ipc::Hidden {
        lines: not_records,
        ..redactor.hidden()
    };
    (text, hidden)
}

fn write_record(text: &mut String, record: &Record, redactor: &mut Redactor) {
    if !record.time.is_empty() {
        // To the second, in UTC, as the file says it.
        match record.time.get(..19) {
            Some(time) => {
                text.push_str(time);
                if record.time.ends_with('Z') {
                    text.push('Z');
                }
            }
            None => text.push_str(&record.time),
        }
        text.push(' ');
    }
    if !record.level.is_empty() {
        text.push_str(&format!("{:<5} ", record.level));
    }
    if !record.target.is_empty() {
        text.push_str(&record.target);
        text.push(' ');
    }
    text.push_str(&redactor.text(&record.message).replace('\n', "\n    "));
    let mut blocks = Vec::new();
    for (name, value) in &record.fields {
        let value = match value {
            Value::Null => continue,
            Value::String(value) => redactor
                .field(name, value)
                .unwrap_or_else(|| redactor.text(value)),
            other => redactor.text(&other.to_string()),
        };
        if value.contains('\n') {
            blocks.push((name, value));
        } else {
            text.push_str(&format!(" {name}={value}"));
        }
    }
    text.push('\n');
    for (name, value) in blocks {
        text.push_str(&format!("    {name}:\n"));
        for line in value.lines() {
            text.push_str("      ");
            text.push_str(line);
            text.push('\n');
        }
    }
}
