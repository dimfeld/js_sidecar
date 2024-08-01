use thiserror::Error;

#[derive(Debug, Error)]
pub enum Error {
    #[error("Failed to serialize JSON payload")]
    JsonSerialize(#[from] serde_json::Error),

    #[error("Failed to read from stream")]
    ReadStream(std::io::Error),

    #[error("Failed to write to stream")]
    WriteStream(std::io::Error),

    #[error("Failed to start Node worker")]
    StartWorker(std::io::Error),

    #[error("Failed to connect to worker socket")]
    ConnectWorker(std::io::Error),

    #[error("Unknown message type {0}")]
    InvalidMessageType(u32),
}
