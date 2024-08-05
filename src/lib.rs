//! js_sidecar is s Rust crate that makes it easy to JavaScript instead of embedding a JS library directly into the application,
//! passes JavaScript code to a separate, persistent Node.js process for execution.
//!
#[deny(missing_docs)]
mod connection;
mod error;
mod messages;
mod protocol;

pub use connection::*;
pub use error::Error;
pub use messages::*;
