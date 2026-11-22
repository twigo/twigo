//! What a panic does in Twigo (ARCHITECTURE 2.1).
//!
//! A panic never takes the process down by itself. The app-wide duties run
//! under a [`Supervisor`], which starts one again after a panic, a few times,
//! and then takes the fatal path. An item that a person opened, a list, a
//! shell, a forward, ends through [`contain()`]: its owner sends the end the
//! item already has and nothing starts it again. A joined task's panic goes
//! on through [`joined`], or through [`blocking`] for a closure on the
//! blocking pool, so the panic hook records it once.

mod contain;
pub mod inject;
mod supervisor;

pub use contain::{Panicked, blocking, contain, joined};
pub use supervisor::{Fatal, Reporter, Reports, Supervisor, reports};
