use std::{io, path::PathBuf, sync::atomic::AtomicU64, time::Duration};

use tempfile::NamedTempFile;
use tokio::{
    net::{unix::OwnedWriteHalf, UnixStream},
    process::{Child, Command},
    sync::mpsc,
};

use crate::{
    error::RunScriptError,
    messages::RunScriptArgs,
    protocol::{
        HostToWorkerMessage, HostToWorkerMessageData, WorkerToHostMessage, WorkerToHostMessageData,
    },
    Error, RunResponseData,
};

const SCRIPT: &str = include_str!("./worker/dist/index.js");

/// To ensure unique sockets per instance
static COUNTER: AtomicU64 = AtomicU64::new(0);

pub struct JsSidecar {
    node_process: Option<Child>,
    socket_path: PathBuf,
    _script_file: NamedTempFile,
}

impl JsSidecar {
    pub async fn new() -> Result<Self, Error> {
        let pid = std::process::id();
        let counter = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let temp_dir = std::env::temp_dir();
        let socket_path = temp_dir.join(format!("js_sidecar.{}.{}.sock", pid, counter));

        let input_script = tempfile::Builder::new()
            .prefix("js_sidecar")
            .suffix(".mjs")
            .tempfile()
            .map_err(Error::StartWorker)?;

        let script_path = input_script.path();

        tokio::fs::write(script_path, SCRIPT.as_bytes())
            .await
            .map_err(Error::StartWorker)?;

        let node_process = Command::new("node")
            // Enable ES Module functionality in vm package
            .arg("--experimental-vm-modules")
            .arg(script_path)
            .arg("--socket")
            .arg(&socket_path)
            .spawn()
            .map_err(Error::StartWorker)?;

        let mut checks = 0;

        while checks < 50 {
            // Wait for the socket to appear
            // TODO This should really have a better interlock
            if std::fs::metadata(&socket_path).is_ok() {
                break;
            }
            // Wait until the socket exists and can be connected
            let stream = UnixStream::connect(&socket_path).await;
            if stream.is_ok() {
                break;
            }

            tokio::time::sleep(Duration::from_millis(10)).await;
            checks += 1;
        }

        if checks == 50 {
            return Err(Error::StartWorker(io::Error::other(
                "Timed out waiting for socket to be ready",
            )));
        }

        Ok(JsSidecar {
            node_process: Some(node_process),
            socket_path,
            // Make sure we keep the script file alive as long as the sidecar is alive.
            _script_file: input_script,
        })
    }

    /// Create a new connection with its own run context.
    pub async fn connect(&self) -> Result<Connection, Error> {
        // TODO add retries here
        let stream = UnixStream::connect(&self.socket_path)
            .await
            .map_err(Error::ConnectWorker)?;
        Connection::new(stream)
    }

    pub async fn close(&mut self) {
        if let Some(child) = self.node_process.take() {
            Self::close_child(child).await;
        }
    }

    async fn close_child(mut child: Child) {
        let Some(pid) = child.id() else {
            // child has already exited
            return;
        };

        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(pid as i32),
            nix::sys::signal::SIGTERM,
        )
        .ok();

        let term_result = tokio::time::timeout(Duration::from_secs(5), child.wait()).await;

        if term_result.is_err() {
            // The child didn't shut down, so force it.
            child.kill().await.ok();
        }
    }
}

impl Drop for JsSidecar {
    fn drop(&mut self) {
        if let Some(child) = self.node_process.take() {
            tokio::task::spawn(async move {
                Self::close_child(child).await;
            });
        }
    }
}

pub struct Connection {
    stream: OwnedWriteHalf,
    receiver: mpsc::Receiver<WorkerToHostMessage>,
    next_id: u32,
    next_req_id: u32,
}

impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection").finish_non_exhaustive()
    }
}

impl Connection {
    fn new(stream: UnixStream) -> Result<Self, Error> {
        let (sender, receiver) = mpsc::channel(16);
        let (mut read_stream, write_stream) = stream.into_split();

        tokio::task::spawn(async move {
            loop {
                match WorkerToHostMessage::read_from(&mut read_stream).await {
                    Ok(message) => {
                        if sender.send(message).await.is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("Failed to read message from worker: {e:?}");
                        break;
                    }
                }
            }
        });

        Ok(Connection {
            stream: write_stream,
            receiver,
            next_id: 0,
            next_req_id: 0,
        })
    }

    pub async fn run_script(&mut self, args: RunScriptArgs) -> Result<(), Error> {
        let message_id = self.next_id;
        let req_id = self.next_req_id;
        self.next_req_id += 1;
        self.next_id += 1;
        let message =
            HostToWorkerMessage::new(req_id, message_id, HostToWorkerMessageData::RunScript(args));
        message.write_to(&mut self.stream).await?;
        Ok(())
    }

    pub async fn receive_message(&mut self) -> Option<WorkerToHostMessage> {
        self.receiver.recv().await
    }

    pub async fn run_script_and_wait(
        &mut self,
        args: RunScriptArgs,
    ) -> Result<RunScriptAndWaitResult, Error> {
        self.run_script(args).await?;

        let mut intermediate_messages = Vec::new();

        while let Some(message) = self.receive_message().await {
            match message.data {
                WorkerToHostMessageData::RunResponse(response) => {
                    return Ok(RunScriptAndWaitResult {
                        response,
                        messages: intermediate_messages,
                    });
                }
                WorkerToHostMessageData::Error(error) => {
                    return Err(Error::Script(RunScriptError {
                        error,
                        messages: intermediate_messages,
                    }));
                }
                _ => {
                    intermediate_messages.push(message.data);
                }
            }
        }

        Err(Error::ScriptEndedEarly)
    }
}

#[derive(Debug, Clone)]
pub struct RunScriptAndWaitResult {
    pub response: RunResponseData,
    pub messages: Vec<WorkerToHostMessageData>,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::protocol::WorkerToHostMessageData;

    // Compile error if Connection is not Send + Sync
    #[allow(dead_code)]
    trait IsSync: Send + Sync {}
    impl IsSync for Connection {}

    #[tokio::test]
    async fn regular_execution() {
        let mut sidecar = JsSidecar::new().await.unwrap();
        let mut connection = sidecar.connect().await.unwrap();

        let args = RunScriptArgs {
            code: r##"
                console.log('Hello, World!');
                output = output + 15;
            "##
            .into(),
            globals: [("output".into(), json!(5))].into_iter().collect(),
            ..Default::default()
        };
        connection.run_script(args).await.unwrap();

        let mut messages = Vec::new();

        while let Some(message) = connection.receive_message().await {
            let finished = matches!(message.data, WorkerToHostMessageData::RunResponse(_));
            println!("{message:#?}");
            messages.push(message);

            if finished {
                drop(connection);
                break;
            }
        }

        assert_eq!(messages.len(), 2);

        let console_msg = &messages[0];

        let WorkerToHostMessageData::Log(log) = &console_msg.data else {
            panic!("Expected log message, saw {console_msg:#?}");
        };

        assert_eq!(log.message, json!(["Hello, World!"]));
        assert_eq!(log.level, "info");

        let response_msg = &messages[1];

        let WorkerToHostMessageData::RunResponse(response) = &response_msg.data else {
            panic!("Expected response message, saw {response_msg:#?}");
        };

        assert_eq!(response.globals["output"], json!(20));
        sidecar.close().await;
    }

    #[tokio::test]
    async fn expression_execution() {
        let mut sidecar = JsSidecar::new().await.unwrap();
        let mut connection = sidecar.connect().await.unwrap();

        let args = RunScriptArgs {
            code: r##"
                output + 15
            "##
            .into(),
            expr: true,
            globals: [("output".into(), json!(5))].into_iter().collect(),
            ..Default::default()
        };
        connection.run_script(args).await.unwrap();

        let mut messages = Vec::new();

        while let Some(message) = connection.receive_message().await {
            let finished = matches!(message.data, WorkerToHostMessageData::RunResponse(_));
            println!("{message:#?}");
            messages.push(message);

            if finished {
                break;
            }
        }

        assert_eq!(messages.len(), 1);

        let response_msg = &messages[0];

        let WorkerToHostMessageData::RunResponse(response) = &response_msg.data else {
            panic!("Expected response message, saw {response_msg:#?}");
        };

        assert_eq!(response.return_value, Some(json!(20)));

        drop(connection);
        sidecar.close().await;
    }

    #[tokio::test]
    async fn run_script_and_wait() {
        let mut sidecar = JsSidecar::new().await.unwrap();
        let mut connection = sidecar.connect().await.unwrap();

        let args = RunScriptArgs {
            code: r##"
                console.log('abc');
                output = 15
            "##
            .into(),
            globals: [("output".into(), json!(5))].into_iter().collect(),
            ..Default::default()
        };
        let result = connection.run_script_and_wait(args).await.unwrap();

        assert_eq!(result.response.globals["output"], json!(15));
        assert_eq!(result.messages.len(), 1);
        assert!(matches!(
            result.messages[0],
            WorkerToHostMessageData::Log(_)
        ));

        drop(connection);
        sidecar.close().await;
    }

    #[tokio::test]
    async fn error() {
        let mut sidecar = JsSidecar::new().await.unwrap();
        let mut connection = sidecar.connect().await.unwrap();

        let args = RunScriptArgs {
            code: r##"
                throw new Error('This is an error');
            "##
            .into(),
            ..Default::default()
        };
        let result = connection.run_script_and_wait(args).await.unwrap_err();

        let Error::Script(err) = result else {
            panic!("Expected Script error, saw {result:#?}");
        };

        assert_eq!(err.error.message, "This is an error");

        drop(connection);
        sidecar.close().await;
    }
}
