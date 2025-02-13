use deadpool::managed::BuildError;
use thiserror::Error;

use crate::{protocol::WorkerToHostMessageData, ErrorResponseData};

#[derive(Debug)]
pub struct RunScriptError {
    pub error: ErrorResponseData,
    pub messages: Vec<WorkerToHostMessageData>,
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("Failed to serialize JSON payload")]
    JsonSerialize(#[from] serde_json::Error),

    #[error("Failed to read from stream")]
    ReadStream(std::io::Error),

    #[error("Failed to write to stream")]
    WriteStream(std::io::Error),

    #[error("Timed out communicating with worker")]
    Timeout,

    #[error("Failed to start Node worker")]
    StartWorker(std::io::Error),

    #[error("Failed to connect to worker socket")]
    ConnectWorker(std::io::Error),

    #[error("Connection is out of sync with worker")]
    ConnectionOutOfSync,

    #[error("Failed to get connection from the pool")]
    Pool(Box<deadpool::managed::PoolError<Error>>),

    #[error("Failed to build connection pool")]
    BuildPool(BuildError),

    #[error("Unknown message type {0}")]
    InvalidMessageType(u32),

    #[error("ScriptError: {}", .0.error.message)]
    Script(RunScriptError),

    #[error("Script ended without a response")]
    ScriptEndedEarly,
}
