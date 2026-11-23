//! Helm releases, read from the Secrets Helm keeps them in (ARCHITECTURE
//! 3.6): v3 and v4 store them alike, one Secret a revision. Pure, as
//! `twigo-describe` is: no I/O, and no tokio.
//!
//! [`summary`] reads what a list row and a history line need, [`page`] what
//! a release's editor shows: its values, manifest, notes and description
//! are secret-grade, held in Rust and given out only masked, scrubbed or
//! through [`Page::revealed`].

mod decode;
mod describe;
mod page;
mod status;

pub use decode::{BOUND, Stored, Summary, summary};
pub use describe::{Release, line, overview};
pub use page::{Page, compared, page};
pub use status::Status;
