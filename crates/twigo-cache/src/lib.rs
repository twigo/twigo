//! The watch hub (ARCHITECTURE 3.1–3.3): upstreams that list and watch
//! what views show, and the row stores they keep.

pub mod batcher;
mod cluster;
pub mod decode;
pub mod discovery;
#[cfg(test)]
mod fake;
pub mod hub;
pub mod meta;
pub mod metrics;
pub mod object;
pub mod request;
pub mod store;
pub mod table;
mod upstream;
pub mod view;
