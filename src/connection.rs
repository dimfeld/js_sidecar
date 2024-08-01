use std::{
    error::Error,
    os::unix::net::UnixStream,
    path::PathBuf,
    process::{Child, Command},
    sync::{atomic::AtomicU64, Arc, Mutex},
};

use tokio::sync::mpsc;

use crate::protocol::{HostToWorkerMessage, HostToWorkerMessageData, WorkerToHostMessage};

/// To ensure unique sockets per instance
static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct JsSidecar {
    node_process: Child,
    socket_path: PathBuf,
}

impl JsSidecar {
    pub fn new(node_script_path: &str) -> Result<Self, Box<dyn Error>> {
        let pid = std::process::id();
        let counter = COUNTER.fetch_add(1, std::sync::Ordering::Relaxed);
        let temp_dir = std::env::temp_dir();
        let socket_path = temp_dir.join(format!("js_sidecar.{}.{}.sock", pid, counter));

        let node_process = Command::new("node")
            .arg(node_script_path)
            .arg("--socket")
            .arg(&socket_path)
            .spawn()?;

        Ok(JsSidecar {
            node_process,
            socket_path,
        })
    }

    /// Create a new connection with its own run context.
    pub fn connect(&self) -> Result<Connection, Box<dyn Error>> {
        let stream = UnixStream::connect(&self.socket_path)?;
        Connection::new(stream)
    }

    pub fn close(&self) {
        self.node_process.kill().ok();
    }
}

impl Drop for JsSidecar {
    fn drop(&mut self) {
        self.node_process.kill().ok();
    }
}

pub struct Connection {
    stream: UnixStream,
    receiver: mpsc::Receiver<WorkerToHostMessage>,
}

impl Connection {
    fn new(stream: UnixStream) -> Result<Self, Box<dyn Error>> {
        let (sender, receiver) = mpsc::channel(100);
        let stream = stream;
        let read_steam = stream.try_clone()?;

        tokio::spawn(async move {
            loop {
                match WorkerToHostMessage::read_from(&mut read_stream) {
                    Ok(message) => {
                        if sender.send(message).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(Connection { stream, receiver })
    }

    pub fn send_run_script(&self, args: RunScriptArgs) -> Result<(), Box<dyn Error>> {
        let message = HostToWorkerMessage::new(0, 0, HostToWorkerMessageData::RunScript(args));
        let mut stream = self.stream.lock().unwrap();
        message.write_to(&mut stream)?;
        Ok(())
    }

    pub async fn receive_message(&mut self) -> Option<WorkerToHostMessage> {
        self.receiver.recv().await
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.stream.shutdown(std::net::Shutdown::Both).ok();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_js_sidecar() {
        let sidecar = JsSidecar::new("path/to/node/script.js").unwrap();
        let mut connection = sidecar.connect().unwrap();

        let args = RunScriptArgs {
            code: "console.log('Hello, World!');".to_string(),
        };
        connection.send_run_script(args).unwrap();

        while let Some(message) = connection.receive_message().await {
            println!("Received message: {:?}", message);
        }
    }
}
