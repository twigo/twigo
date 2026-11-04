//! A line as the kubelet sends it with `timestamps=true`: its time in
//! RFC 3339 with nine fractional digits, a space, then what the container
//! wrote, ANSI escapes and all (kubernetes v1.37.0, cri-client
//! `pkg/logs/logs.go`, `timeFormatOut`).

use anstyle::{Ansi256Color, RgbColor};
use anstyle_lossy::palette::VGA;
use anstyle_parse::{Params, Parser, Perform};
use twigo_ipc::{AnsiColor, TextRange, TextStyle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Parsed {
    /// Nanoseconds since the Unix epoch, None for a line whose time does
    /// not parse.
    pub at: Option<i64>,
    pub text: String,
    pub styles: Vec<TextStyle>,
}

/// A line without its line feed.
pub fn parse(line: &[u8]) -> Parsed {
    let line = line.strip_suffix(b"\n").unwrap_or(line);
    let split = line.iter().position(|byte| *byte == b' ');
    let (at, rest) = match split.map(|at| (time(&line[..at]), &line[at + 1..])) {
        Some((Some(at), rest)) => (Some(at), rest),
        _ => (None, line),
    };
    let (text, styles) = styled(rest);
    Parsed { at, text, styles }
}

fn time(text: &[u8]) -> Option<i64> {
    let parsed: jiff::Timestamp = std::str::from_utf8(text).ok()?.parse().ok()?;
    i64::try_from(parsed.as_nanosecond()).ok()
}

/// The text without its escapes, and what their SGR sequences styled, in
/// runs of UTF-16 units. A tab stays; other control characters go, a
/// carriage return before the line feed among them.
fn styled(bytes: &[u8]) -> (String, Vec<TextStyle>) {
    let mut parser = Parser::<anstyle_parse::DefaultCharAccumulator>::new();
    let mut styler = Styler::default();
    for byte in bytes {
        parser.advance(&mut styler, *byte);
    }
    styler.close();
    (styler.text, styler.styles)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct Style {
    fg: Option<AnsiColor>,
    bg: Option<AnsiColor>,
    bold: bool,
    dim: bool,
    italic: bool,
    underline: bool,
}

impl Style {
    fn over(self, range: TextRange) -> TextStyle {
        let Style {
            fg,
            bg,
            bold,
            dim,
            italic,
            underline,
        } = self;
        TextStyle {
            range,
            fg,
            bg,
            bold,
            dim,
            italic,
            underline,
        }
    }
}

#[derive(Default)]
struct Styler {
    text: String,
    styles: Vec<TextStyle>,
    style: Style,
    /// Where the current style's run started, in UTF-16 units.
    from: u32,
    at: u32,
}

impl Styler {
    fn push(&mut self, c: char) {
        self.text.push(c);
        self.at += c.len_utf16() as u32;
    }

    fn restyle(&mut self, style: Style) {
        if style != self.style {
            self.close();
            self.style = style;
            self.from = self.at;
        }
    }

    /// Ends the current run, joined to the one before when they touch with
    /// the same style.
    fn close(&mut self) {
        if self.at == self.from || self.style == Style::default() {
            return;
        }
        if let Some(last) = self.styles.last_mut()
            && last.range.end == self.from
            && *last == self.style.over(last.range)
        {
            last.range.end = self.at;
        } else {
            let range = TextRange {
                start: self.from,
                end: self.at,
            };
            self.styles.push(self.style.over(range));
        }
        self.from = self.at;
    }
}

impl Perform for Styler {
    fn print(&mut self, c: char) {
        self.push(c);
    }

    fn execute(&mut self, byte: u8) {
        if byte == b'\t' {
            self.push('\t');
        }
    }

    fn csi_dispatch(&mut self, params: &Params, intermediates: &[u8], ignore: bool, action: u8) {
        if action == b'm' && intermediates.is_empty() && !ignore {
            let style = sgr(self.style, params);
            self.restyle(style);
        }
    }
}

/// What an SGR sequence makes of a style, as ECMA-48 and xterm read its
/// parameters, `38;5;n`, `38;2;r;g;b` and their colon forms included, as
/// vte 0.15's `attrs_from_sgr_parameters` reads them. Blinking, inverse,
/// hidden and struck text keep their characters and lose their effect.
fn sgr(mut style: Style, params: &Params) -> Style {
    let params: Vec<&[u16]> = params.iter().collect();
    let mut rest = params.iter();
    while let Some(param) = rest.next() {
        match *param {
            [0] => style = Style::default(),
            [1] => style.bold = true,
            [2] => style.dim = true,
            [3] => style.italic = true,
            [4, 0] => style.underline = false,
            [4, ..] => style.underline = true,
            [21] => style.bold = false,
            [22] => (style.bold, style.dim) = (false, false),
            [23] => style.italic = false,
            [24] => style.underline = false,
            [n @ 30..=37] => style.fg = Some(named(n - 30)),
            [38] => style.fg = semicolon_color(&mut rest),
            [38, color @ ..] => style.fg = colon_color(color),
            [39] => style.fg = None,
            [n @ 40..=47] => style.bg = Some(named(n - 40)),
            [48] => style.bg = semicolon_color(&mut rest),
            [48, color @ ..] => style.bg = colon_color(color),
            [49] => style.bg = None,
            // An underline's colour, read so its numbers style nothing.
            [58] => {
                semicolon_color(&mut rest);
            }
            [n @ 90..=97] => style.fg = Some(named(n - 90 + 8)),
            [n @ 100..=107] => style.bg = Some(named(n - 100 + 8)),
            _ => {}
        }
    }
    style
}

fn semicolon_color(rest: &mut std::slice::Iter<'_, &[u16]>) -> Option<AnsiColor> {
    let mut next = || rest.next().map(|param| param[0]);
    match next()? {
        5 => indexed(next()?),
        2 => rgb(next()?, next()?, next()?),
        _ => None,
    }
}

/// `5:n`, `2:r:g:b`, or `2:space:r:g:b` with a colour space id.
fn colon_color(color: &[u16]) -> Option<AnsiColor> {
    match color {
        [5, index] => indexed(*index),
        [2, r, g, b] | [2, _, r, g, b] => rgb(*r, *g, *b),
        _ => None,
    }
}

fn indexed(index: u16) -> Option<AnsiColor> {
    let index = u8::try_from(index).ok()?;
    Some(sixteen(anstyle_lossy::xterm_to_ansi(
        Ansi256Color(index),
        VGA,
    )))
}

/// The nearest of the sixteen in the VGA palette, which anstyle-lossy
/// matches with a weighted distance; any palette would do, and a fixed one
/// keeps Rust and the mock alike.
fn rgb(r: u16, g: u16, b: u16) -> Option<AnsiColor> {
    let channel = |value: u16| u8::try_from(value).ok();
    let color = RgbColor(channel(r)?, channel(g)?, channel(b)?);
    Some(sixteen(anstyle_lossy::rgb_to_ansi(color, VGA)))
}

fn named(index: u16) -> AnsiColor {
    let index = u8::try_from(index).expect("one of the sixteen");
    sixteen(Ansi256Color(index).into_ansi().expect("one of the sixteen"))
}

fn sixteen(color: anstyle::AnsiColor) -> AnsiColor {
    use anstyle::AnsiColor as A;
    match color {
        A::Black => AnsiColor::Black,
        A::Red => AnsiColor::Red,
        A::Green => AnsiColor::Green,
        A::Yellow => AnsiColor::Yellow,
        A::Blue => AnsiColor::Blue,
        A::Magenta => AnsiColor::Magenta,
        A::Cyan => AnsiColor::Cyan,
        A::White => AnsiColor::White,
        A::BrightBlack => AnsiColor::BrightBlack,
        A::BrightRed => AnsiColor::BrightRed,
        A::BrightGreen => AnsiColor::BrightGreen,
        A::BrightYellow => AnsiColor::BrightYellow,
        A::BrightBlue => AnsiColor::BrightBlue,
        A::BrightMagenta => AnsiColor::BrightMagenta,
        A::BrightCyan => AnsiColor::BrightCyan,
        A::BrightWhite => AnsiColor::BrightWhite,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn style(start: u32, end: u32, fg: Option<AnsiColor>) -> TextStyle {
        TextStyle {
            range: TextRange { start, end },
            fg,
            bg: None,
            bold: false,
            dim: false,
            italic: false,
            underline: false,
        }
    }

    #[test]
    fn the_time_comes_off_the_text() {
        let line = parse(b"2026-11-03T10:00:00.123456789Z GET /healthz 200\n");
        assert_eq!(line.at, Some(1_793_700_000_123_456_789));
        assert_eq!(line.text, "GET /healthz 200");
        assert!(line.styles.is_empty());
    }

    #[test]
    fn a_line_without_a_time_is_all_text() {
        let line = parse(b"no time here");
        assert_eq!((line.at, line.text.as_str()), (None, "no time here"));
    }

    #[test]
    fn escapes_leave_their_text_and_style_it() {
        let (text, styles) = styled(b"\x1b[1;31mERROR\x1b[0m db \x1b[2mslow\x1b[22m\r");
        assert_eq!(text, "ERROR db slow");
        let mut error = style(0, 5, Some(AnsiColor::Red));
        error.bold = true;
        let mut slow = style(9, 13, None);
        slow.dim = true;
        assert_eq!(styles, [error, slow]);
    }

    #[test]
    fn colours_beyond_the_sixteen_come_as_the_nearest() {
        let (_, styles) =
            styled(b"\x1b[38;5;196ma\x1b[38;2;0;0;200mb\x1b[38:2::0:200:0mc\x1b[48;5;9md");
        assert_eq!(
            styles
                .iter()
                .map(|style| (style.fg, style.bg))
                .collect::<Vec<_>>(),
            [
                (Some(AnsiColor::Red), None),
                (Some(AnsiColor::Blue), None),
                (Some(AnsiColor::Green), None),
                (Some(AnsiColor::Green), Some(AnsiColor::BrightRed)),
            ]
        );
    }

    #[test]
    fn ranges_count_utf16_units_and_runs_of_one_style_join() {
        let (text, styles) = styled("\x1b[32m✓ 😀\x1b[32m!\x1b[39m\tok".as_bytes());
        assert_eq!(text, "✓ 😀!\tok");
        assert_eq!(styles, [style(0, 5, Some(AnsiColor::Green))]);
    }

    #[test]
    fn other_sequences_go_without_a_trace() {
        let (text, styles) =
            styled(b"\x1b[2K\x1b]8;;https://twigo.io\x1b\\link\x1b]8;;\x1b\\\x1b[?25l done");
        assert_eq!(text, "link done");
        assert!(styles.is_empty());
    }
}
