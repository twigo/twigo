//! Resource quantities (apimachinery v0.37.1, `resource.Quantity`), read
//! as billionths, the finest the type keeps: what is finer is rounded up,
//! as `MilliValue` and `Value` round up what they cut.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct Quantity(i128);

const NANO: i128 = 1_000_000_000;

impl Quantity {
    pub const ONE: Quantity = Quantity(NANO);
    pub const ZERO: Quantity = Quantity(0);

    /// `500m`, `1.5Gi`, `2e3`; None for anything else.
    pub fn parse(text: &str) -> Option<Self> {
        let text = text.trim();
        let (negative, text) = match text.strip_prefix('-') {
            Some(rest) => (true, rest),
            None => (false, text.strip_prefix('+').unwrap_or(text)),
        };
        let end = text
            .find(|c: char| !c.is_ascii_digit() && c != '.')
            .unwrap_or(text.len());
        let (number, suffix) = text.split_at(end);
        let (whole, fraction) = number.split_once('.').unwrap_or((number, ""));
        if whole.is_empty() && fraction.is_empty() || fraction.contains('.') {
            return None;
        }
        let digits: i128 = format!("{whole}{fraction}").parse().ok()?;
        let scale = 10i128.checked_pow(u32::try_from(fraction.len()).ok()?)?;
        let (num, den): (i128, i128) = match suffix {
            "n" => (1, 1_000_000_000),
            "u" => (1, 1_000_000),
            "m" => (1, 1000),
            "" => (1, 1),
            "k" => (1000, 1),
            "M" => (1_000_000, 1),
            "G" => (1_000_000_000, 1),
            "T" => (1_000_000_000_000, 1),
            "P" => (1_000_000_000_000_000, 1),
            "E" => (1_000_000_000_000_000_000, 1),
            "Ki" => (1 << 10, 1),
            "Mi" => (1 << 20, 1),
            "Gi" => (1 << 30, 1),
            "Ti" => (1 << 40, 1),
            "Pi" => (1 << 50, 1),
            "Ei" => (1 << 60, 1),
            exponent => {
                let power: i32 = exponent
                    .strip_prefix(['e', 'E'])
                    .and_then(|power| power.parse().ok())?;
                let ten = 10i128.checked_pow(power.unsigned_abs())?;
                if power >= 0 { (ten, 1) } else { (1, ten) }
            }
        };
        let nano = div_ceil(
            digits.checked_mul(NANO)?.checked_mul(num)?,
            scale.checked_mul(den)?,
        );
        Some(Quantity(if negative { -nano } else { nano }))
    }

    /// In billionths, which is what `n` writes.
    pub fn nano(self) -> i128 {
        self.0
    }

    /// In thousandths, rounded up as `MilliValue`.
    pub fn milli(self) -> i128 {
        div_ceil(self.0, NANO / 1000)
    }

    /// Rounded up to a whole, as `Value`.
    pub fn value(self) -> i128 {
        div_ceil(self.0, NANO)
    }
}

impl std::ops::Add for Quantity {
    type Output = Quantity;

    fn add(self, other: Quantity) -> Quantity {
        Quantity(self.0 + other.0)
    }
}

pub fn div_ceil(a: i128, b: i128) -> i128 {
    let quotient = a / b;
    if a % b != 0 && (a > 0) == (b > 0) {
        quotient + 1
    } else {
        quotient
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quantities_read_as_kubernetes_writes_them() {
        for (text, milli) in [
            ("500m", 500),
            ("1", 1000),
            ("0.5", 500),
            ("1.5Gi", 1_610_612_736_000),
            ("16Mi", 16_777_216_000),
            ("2k", 2_000_000),
            ("2e3", 2_000_000),
            ("1n", 1),
            ("100u", 1),
            ("-1", -1000),
            ("50172044n", 51),
            ("1999934n", 2),
            ("0", 0),
            ("204Ki", 208_896_000),
            ("40Mi", 41_943_040_000),
        ] {
            assert_eq!(
                Quantity::parse(text).map(Quantity::milli),
                Some(milli),
                "{text}"
            );
        }
        for text in [
            "",
            "Gi",
            "1.2.3",
            "1x",
            "abc",
            "0.000000000000000000000000000001n",
            "1.0000000000e-30",
        ] {
            assert_eq!(Quantity::parse(text), None, "{text}");
        }
        assert_eq!(Quantity::parse("1500m").map(Quantity::value), Some(2));
    }

    #[test]
    fn what_metrics_server_writes_keeps_its_nanocores_and_bytes() {
        for (text, nano) in [
            ("50172044n", 50_172_044),
            ("277147502n", 277_147_502),
            ("68758110500n", 68_758_110_500),
            ("0", 0),
            ("1", 1_000_000_000),
            ("250m", 250_000_000),
            ("1500u", 1_500_000),
            ("1n", 1),
        ] {
            assert_eq!(
                Quantity::parse(text).map(Quantity::nano),
                Some(nano),
                "{text}"
            );
        }
        for (text, bytes) in [
            ("204Ki", 208_896),
            ("2509700Ki", 2_569_932_800),
            ("40Mi", 41_943_040),
            ("1Mi", 1_048_576),
            ("0", 0),
            ("123456", 123_456),
            ("12M", 12_000_000),
            ("1500m", 2),
        ] {
            assert_eq!(
                Quantity::parse(text).map(Quantity::value),
                Some(bytes),
                "{text}"
            );
        }
    }
}
