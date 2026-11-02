//! The watch hub (ARCHITECTURE 3.1–3.3): upstreams that list and watch
//! what views show, and the row stores they keep.

mod cluster;
pub mod decode;
#[cfg(test)]
mod fake;
pub mod hub;
pub mod meta;
pub mod object;
pub mod request;
pub mod store;
pub mod table;
mod upstream;
