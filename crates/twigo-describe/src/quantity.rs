//! Resource quantities (apimachinery v0.37.1, `resource.Quantity`), read
//! as thousandths, rounded up as `MilliValue` rounds them.

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) struct Quantity(i128);

impl Quantity {
    pub const ONE: Quantity = Quantity(1000);
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
        let milli = div_ceil(digits.checked_mul(1000)?.checked_mul(num)?, scale * den);
        Some(Quantity(if negative { -milli } else { milli }))
    }

    /// In thousandths, as `MilliValue`.
    pub fn milli(self) -> i128 {
        self.0
    }

    /// Rounded up to a whole, as `Value`.
    pub fn value(self) -> i128 {
        div_ceil(self.0, 1000)
    }
}

impl std::ops::Add for Quantity {
    type Output = Quantity;

    fn add(self, other: Quantity) -> Quantity {
        Quantity(self.0 + other.0)
    }
}

pub(crate) fn div_ceil(a: i128, b: i128) -> i128 {
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
        ] {
            assert_eq!(
                Quantity::parse(text).map(Quantity::milli),
                Some(milli),
                "{text}"
            );
        }
        for text in ["", "Gi", "1.2.3", "1x", "abc"] {
            assert_eq!(Quantity::parse(text), None, "{text}");
        }
        assert_eq!(Quantity::parse("1500m").map(Quantity::value), Some(2));
    }
}
