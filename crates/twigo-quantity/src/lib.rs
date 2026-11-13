//! Resource quantities as apimachinery's `resource.Quantity` reads them
//! ([v0.37.0](https://github.com/kubernetes/apimachinery/blob/v0.37.0/pkg/api/resource/quantity.go)),
//! in billionths, the finest the type keeps: the parse rounds what is finer
//! up, away from zero, to one billionth
//! ([`ParseQuantity`](https://github.com/kubernetes/apimachinery/blob/v0.37.0/pkg/api/resource/quantity.go#L369-L375)),
//! and caps a binary suffix's value at the largest int64
//! ([L377-L381](https://github.com/kubernetes/apimachinery/blob/v0.37.0/pkg/api/resource/quantity.go#L377-L381)).
//! `Value` and `MilliValue` round what they cut up, away from zero, also
//! below zero ([`Value`](https://github.com/kubernetes/apimachinery/blob/v0.37.0/pkg/api/resource/quantity.go#L813-L835),
//! [`negativeScaleInt64`](https://github.com/kubernetes/apimachinery/blob/v0.37.0/pkg/api/resource/math.go#L166-L199)).
//!
//! Sums are made in billionths and rounded once by whoever reads them, as
//! `Quantity.Add` sums exactly. What passes about 1.7 × 10^29 whole units is
//! not read: apimachinery keeps it in an arbitrary-precision decimal, but
//! its `Value`, `MilliValue` and `ScaledValue` overflow an int64 long before
//! ([`ScaledValue`](https://github.com/kubernetes/apimachinery/blob/v0.37.0/pkg/api/resource/quantity.go#L824-L835)),
//! so nothing that reads a quantity as they do gets a meaning from it.

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
        let numerator = digits.checked_mul(num)?;
        let denominator = scale.checked_mul(den)?;
        let binary = suffix.ends_with('i');
        let nano = if binary && over_int64(numerator, denominator) {
            i128::from(i64::MAX) * NANO
        } else {
            div_ceil(numerator.checked_mul(NANO)?, denominator)
        };
        Some(Quantity(if negative { -nano } else { nano }))
    }

    /// In billionths, which is what `n` writes.
    pub fn nano(self) -> i128 {
        self.0
    }

    /// In thousandths, rounded away from zero as `MilliValue`.
    pub fn milli(self) -> i128 {
        away_from_zero(self.0, NANO / 1000)
    }

    /// Rounded away from zero to a whole, as `Value`.
    pub fn value(self) -> i128 {
        away_from_zero(self.0, NANO)
    }
}

impl std::ops::Add for Quantity {
    type Output = Quantity;

    fn add(self, other: Quantity) -> Quantity {
        Quantity(self.0 + other.0)
    }
}

/// `a / b` for a positive `b`, rounded up when `a` is positive and down when it is not.
fn away_from_zero(a: i128, b: i128) -> i128 {
    let quotient = a / b;
    if a % b != 0 {
        quotient + a.signum()
    } else {
        quotient
    }
}

/// Whether `numerator / denominator` passes the largest int64, as the cap tests it.
fn over_int64(numerator: i128, denominator: i128) -> bool {
    let max = i128::from(i64::MAX);
    let whole = numerator / denominator;
    whole > max || (whole == max && numerator % denominator != 0)
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
    fn what_is_cut_rounds_away_from_zero_below_zero_too() {
        for (text, milli, value) in [
            ("1n", 1, 1),
            ("-1n", -1, -1),
            ("-1500m", -1500, -2),
            ("-1.5", -1500, -2),
            ("-0.0004", -1, -1),
            ("-1", -1000, -1),
            ("0", 0, 0),
        ] {
            let quantity = Quantity::parse(text).unwrap();
            assert_eq!(
                (quantity.milli(), quantity.value()),
                (milli, value),
                "{text}"
            );
        }
    }

    #[test]
    fn a_sum_is_made_exactly_and_rounded_once() {
        let each = Quantity::parse("100u").unwrap();
        assert_eq!(each.milli(), 1);
        let sum = each + each + each;
        assert_eq!((sum.nano(), sum.milli()), (300_000, 1), "not 3 times 1m");
    }

    #[test]
    fn a_binary_suffix_is_capped_at_the_largest_int64_and_a_decimal_is_not() {
        let max = i128::from(i64::MAX);
        for (text, value) in [
            ("200000000000Ei", max),
            ("-200000000000Ei", -max),
            ("8Ei", max),
            ("7Ei", 7 << 60),
            ("9223372036854775808", max + 1),
            ("9223372036854775808k", (max + 1) * 1000),
            ("1e29", 10i128.pow(29)),
        ] {
            assert_eq!(
                Quantity::parse(text).map(Quantity::value),
                Some(value),
                "{text}"
            );
        }
        for text in ["1e30", "200000000000E", "1000000000000000000000000000000"] {
            assert_eq!(Quantity::parse(text), None, "{text}");
        }
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
