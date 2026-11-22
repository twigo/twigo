use std::fmt;

use serde_json::value::RawValue;

/// Secret-grade data held in Rust, such as a release's values or its
/// manifest (ARCHITECTURE 3.6). It has no `Serialize`, so it cannot reach
/// IPC as it is, and its `Debug` prints its size only; only this module's
/// maskers and Reveals read it.
///
/// ```compile_fail
/// let held = twigo_policy::redact::Held::new("hunter2".to_owned());
/// let _ = serde_json::to_string(&held);
/// ```
pub struct Held<T>(pub(super) T);

impl<T> Held<T> {
    pub fn new(value: T) -> Self {
        Held(value)
    }
}

/// What a [`Held`] prints of itself.
pub trait Size {
    /// Its length in bytes.
    fn size(&self) -> usize;
}

impl Size for String {
    fn size(&self) -> usize {
        self.len()
    }
}

impl Size for Box<RawValue> {
    fn size(&self) -> usize {
        self.get().len()
    }
}

impl Size for Vec<String> {
    fn size(&self) -> usize {
        self.iter().map(String::len).sum()
    }
}

impl<T: Size> fmt::Debug for Held<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Held(<{} bytes>)", self.0.size())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn its_debug_prints_a_size_and_no_value() {
        let held = Held::new("hunter2".to_owned());
        let printed = format!("{held:?} {:?}", Held::new(vec!["s3cret".to_owned()]));
        assert_eq!(printed, "Held(<7 bytes>) Held(<6 bytes>)");
    }
}
