use serde::{Deserialize, Serialize};

/// The nearest-rank percentile of `samples`, or `None` when there are none.
pub fn percentile(samples: &[f64], p: f64) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let rank = (p / 100.0 * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

#[derive(Debug, PartialEq, Serialize, Deserialize)]
pub struct Spread {
    pub n: usize,
    pub p50: f64,
    pub p95: f64,
    pub max: f64,
}

impl Spread {
    pub fn of(samples: &[f64]) -> Option<Self> {
        Some(Spread {
            n: samples.len(),
            p50: percentile(samples, 50.0)?,
            p95: percentile(samples, 95.0)?,
            max: percentile(samples, 100.0)?,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank() {
        let samples: Vec<f64> = (1..=20).rev().map(f64::from).collect();
        assert_eq!(percentile(&samples, 50.0), Some(10.0));
        assert_eq!(percentile(&samples, 95.0), Some(19.0));
        assert_eq!(percentile(&samples, 100.0), Some(20.0));
        assert_eq!(percentile(&samples, 0.0), Some(1.0));
        assert_eq!(percentile(&[], 95.0), None);
    }

    #[test]
    fn spread() {
        assert_eq!(
            Spread::of(&[3.0, 1.0, 2.0]),
            Some(Spread {
                n: 3,
                p50: 2.0,
                p95: 3.0,
                max: 3.0
            })
        );
    }
}
