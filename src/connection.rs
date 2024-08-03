use std::{
    io,
    path::PathBuf,
    sync::atomic::{AtomicU64, AtomicUsize, Ordering},
    time::Duration,
};

use deadpool::managed::{Metrics, Pool};
use futures::stream::{self, StreamExt};
use tempfile::NamedTempFile;
use tokio::{
    io::AsyncWriteExt,
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

/// The result of running a script
#[derive(Debug, Clone)]
pub struct RunScriptAndWaitResult {
    /// The result of running the script
    pub response: RunResponseData,
    /// Other messages that arrived in the meantime, such as console logs.
    pub messages: Vec<WorkerToHostMessageData>,
}

/// JsSidecar starts the Node.js process and allows connecting to its socket.
pub struct JsSidecar {
    node_process: Option<Child>,
    socket_path: PathBuf,
    _script_file: NamedTempFile,
    pool: Pool<ConnectionManager>,
}

impl JsSidecar {
    /// Start Node.js and set up the socket.
    /// `num_workers` is the number of worker processes to start, and will use the number of CPUs
    /// on the system if omitted.
    pub async fn new(num_workers: Option<u32>) -> Result<Self, Error> {
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

        let mut command = Command::new("node");

        command
            // Silence warning for experimental-vm-modules
            .arg("--no-warnings=ExperimentalWarning")
            // Enable ES Module functionality in vm package
            .arg("--experimental-vm-modules")
            .arg(script_path)
            .arg("--socket")
            .arg(&socket_path);

        if let Some(num_workers) = num_workers {
            command.arg("--workers").arg(num_workers.to_string());
        }

        let node_process = command.spawn().map_err(Error::StartWorker)?;

        let mut checks = 0;

        while checks < 50 {
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

        let pool = Pool::builder(ConnectionManager {
            socket_path: socket_path.clone(),
            recycle_calls: AtomicUsize::new(0),
            recycle_success: AtomicUsize::new(0),
        })
        .max_size(1024)
        .build()
        .map_err(Error::BuildPool)?;

        Ok(JsSidecar {
            node_process: Some(node_process),
            pool,
            socket_path,
            // Make sure we keep the script file alive as long as the sidecar is alive.
            _script_file: input_script,
        })
    }

    /// Create a new connection with its own run context.
    pub async fn connect(&self) -> Result<PoolConnection, Error> {
        self.pool.get().await.map_err(|e| Error::Pool(Box::new(e)))
    }

    /// Close Node.js
    pub async fn close(&mut self) {
        self.pool.close();
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

/// deadpool Manager for Sidecar connections
pub struct ConnectionManager {
    socket_path: PathBuf,
    recycle_calls: AtomicUsize,
    recycle_success: AtomicUsize,
}

impl deadpool::managed::Manager for ConnectionManager {
    type Type = Connection;
    type Error = Error;

    async fn create(&self) -> Result<Self::Type, Self::Error> {
        let stream = UnixStream::connect(&self.socket_path)
            .await
            .map_err(Error::ConnectWorker)?;
        Connection::new(stream)
    }

    async fn recycle(
        &self,
        conn: &mut Self::Type,
        _metrics: &Metrics,
    ) -> deadpool::managed::RecycleResult<Error> {
        self.recycle_calls.fetch_add(1, Ordering::Relaxed);
        conn.ping().await?;
        let msg = tokio::time::timeout(Duration::from_secs(1), conn.receive_message())
            .await
            .map_err(|_| Error::Timeout)?
            .ok_or(Error::ReadStream(io::Error::other("Worker is closed")))?;

        if !matches!(msg.data, WorkerToHostMessageData::Pong) {
            // if the message is anything other than a Pong, then we're out of sync somehow.
            return Err(deadpool::managed::RecycleError::Backend(
                Error::ConnectionOutOfSync,
            ));
        }

        conn.reset_context_on_next = true;

        self.recycle_success.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// A connection obtained from the connectiion pool inside the [JsSidecar].
pub type PoolConnection = deadpool::managed::Object<ConnectionManager>;

/// A connection to Node.js. Multiple calls on a connection will reuse the execution context,
/// unless explicitly specified otherwise using the [recreate_context] argument.
pub struct Connection {
    stream: OwnedWriteHalf,
    /// The receiver for messages from the Node.js process.
    pub receiver: mpsc::Receiver<WorkerToHostMessage>,
    next_id: u32,
    next_req_id: u32,
    _task_close_tx: tokio::sync::oneshot::Sender<()>,

    reset_context_on_next: bool,
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

        let (close_tx, close_rx) = tokio::sync::oneshot::channel::<()>();

        tokio::task::spawn(async move {
            tokio::pin!(close_rx);
            loop {
                tokio::select! {
                    message = WorkerToHostMessage::read_from(&mut read_stream) => {
                        match message {
                            Ok(message) => {
                                if sender.send(message).await.is_err() {
                                    break;
                                }
                            }
                            Err(_e) => {
                                // eprintln!("Failed to read message from worker: {e:?}");
                                break;
                            }
                        }
                    }

                    _ = &mut close_rx  => {
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
            reset_context_on_next: false,
            _task_close_tx: close_tx,
        })
    }

    /// Start running a script
    pub async fn run_script(&mut self, mut args: RunScriptArgs) -> Result<(), Error> {
        if self.reset_context_on_next {
            self.reset_context_on_next = false;
            args.recreate_context = true;
        }

        let message_id = self.next_id;
        let req_id = self.next_req_id;
        self.next_req_id += 1;
        self.next_id += 1;
        let message =
            HostToWorkerMessage::new(req_id, message_id, HostToWorkerMessageData::RunScript(args));
        message.write_to(&mut self.stream).await?;
        Ok(())
    }

    /// Receive a message from the Node.js process
    pub async fn receive_message(&mut self) -> Option<WorkerToHostMessage> {
        self.receiver.recv().await
    }

    async fn ping(&mut self) -> Result<(), Error> {
        let message_id = self.next_id;
        let req_id = self.next_req_id;
        self.next_req_id += 1;
        self.next_id += 1;
        let message = HostToWorkerMessage::new(req_id, message_id, HostToWorkerMessageData::Ping);
        message.write_to(&mut self.stream).await?;
        Ok(())
    }

    /// Run a script and wait for it to finish, accumulating console messages seen along the way.
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
        let mut sidecar = JsSidecar::new(Some(1)).await.unwrap();
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
        eprintln!("Closing");
        sidecar.close().await;
    }

    #[tokio::test]
    async fn expression_execution() {
        let mut sidecar = JsSidecar::new(None).await.unwrap();
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
            if matches!(&message.data, WorkerToHostMessageData::Error(_)) {
                panic!("Saw error: {message:#?}");
            }

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
        let mut sidecar = JsSidecar::new(Some(1)).await.unwrap();
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
        let mut sidecar = JsSidecar::new(Some(1)).await.unwrap();
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

    #[tokio::test]
    async fn syntax_error() {
        let mut sidecar = JsSidecar::new(Some(1)).await.unwrap();
        let mut connection = sidecar.connect().await.unwrap();

        let args = RunScriptArgs {
            code: r##"
                23jklsdfhio
            "##
            .into(),
            ..Default::default()
        };
        let result = connection.run_script_and_wait(args).await.unwrap_err();

        let Error::Script(err) = result else {
            panic!("Expected Script error, saw {result:#?}");
        };

        assert_eq!(err.error.message, "Invalid or unexpected token");

        drop(connection);
        sidecar.close().await;
    }

    #[tokio::test]
    async fn multiple_connections() {
        let mut sidecar = JsSidecar::new(Some(1)).await.unwrap();

        let connections = (0..8)
            .map(|_| async {
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
            })
            .collect::<Vec<_>>();

        futures::future::join_all(connections).await;
        sidecar.close().await;
    }

    #[tokio::test]
    async fn multiple_connections_and_workers() {
        let mut sidecar = JsSidecar::new(Some(4)).await.unwrap();

        let connections = (0..8)
            .map(|_| async {
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
            })
            .collect::<Vec<_>>();

        futures::future::join_all(connections).await;
        sidecar.close().await;
    }

    #[tokio::test]
    async fn many_connections() {
        let mut sidecar = JsSidecar::new(Some(1)).await.unwrap();

        stream::iter(0..10000)
            .for_each_concurrent(None, |_| async {
                let mut connection = sidecar.connect().await.unwrap();
                let args = RunScriptArgs {
                    code: r##"
                        2 + 2
                "##
                    .into(),
                    expr: true,
                    ..Default::default()
                };

                connection.run_script_and_wait(args).await.unwrap();
            })
            .await;
        let manager = sidecar.pool.manager();

        let calls = manager.recycle_calls.load(Ordering::Relaxed);
        let success = manager.recycle_success.load(Ordering::Relaxed);
        assert_eq!(success, calls);
        sidecar.close().await;
    }
}
