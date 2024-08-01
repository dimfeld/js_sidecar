use std::{
    error::Error,
    io::{Read, Write},
    os::unix::net::UnixStream,
};

use crate::messages::{ErrorResponseData, LogResponseData, RunResponseData, RunScriptArgs};

#[derive(Debug, Clone)]
pub enum HostToWorkerMessageData {
    RunScript(RunScriptArgs),
}

impl HostToWorkerMessageData {
    pub fn message_type(&self) -> u32 {
        match self {
            HostToWorkerMessageData::RunScript(_) => 0,
        }
    }

    pub fn to_buffer(
        &self,
        request_id: u32,
        message_id: u32,
        mut stream: impl Write,
    ) -> Result<(), Box<dyn Error>> {
        let data = match self {
            HostToWorkerMessageData::RunScript(d) => serde_json::to_vec(d)?,
        };

        let length = 12 + data.len() as u32;
        stream.write_all(&length.to_le_bytes())?;
        stream.write_all(&request_id.to_le_bytes())?;
        stream.write_all(&message_id.to_le_bytes())?;
        stream.write_all(&self.message_type().to_le_bytes())?;
        stream.write_all(&data)?;
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub enum WorkerToHostMessageData {
    RunResponse(RunResponseData),
    Log(LogResponseData),
    Error(ErrorResponseData),
}

impl WorkerToHostMessageData {
    pub fn message_type(&self) -> u32 {
        match self {
            WorkerToHostMessageData::RunResponse(_) => 0x1000,
            WorkerToHostMessageData::Log(_) => 0x1001,
            WorkerToHostMessageData::Error(_) => 0x1002,
        }
    }

    pub fn parse_data(message_type: u32, buffer: &[u8]) -> Result<Self, Box<dyn Error>> {
        match message_type {
            0x1000 => Ok(WorkerToHostMessageData::RunResponse(
                serde_json::from_slice(buffer)?,
            )),
            0x1001 => Ok(WorkerToHostMessageData::Log(serde_json::from_slice(
                buffer,
            )?)),
            0x1002 => Ok(WorkerToHostMessageData::Error(serde_json::from_slice(
                buffer,
            )?)),
            code => Err(format!("Unknown message type {code}").into()),
        }
    }
}

pub struct HostToWorkerMessage {
    pub request_id: u32,
    pub message_id: u32,
    pub data: HostToWorkerMessageData,
}

impl HostToWorkerMessage {
    pub fn new(request_id: u32, message_id: u32, data: HostToWorkerMessageData) -> Self {
        HostToWorkerMessage {
            request_id,
            message_id,
            data,
        }
    }

    pub fn write_to(&self, stream: &mut UnixStream) -> Result<(), Box<dyn Error>> {
        self.data
            .to_buffer(self.request_id, self.message_id, stream)?;
        Ok(())
    }
}

pub struct WorkerToHostMessage {
    pub request_id: u32,
    pub message_id: u32,
    pub data: WorkerToHostMessageData,
}

impl WorkerToHostMessage {
    pub fn read_from(stream: &mut UnixStream) -> Result<Self, Box<dyn Error>> {
        let mut header = [0u8; 16];
        stream.read_exact(&mut header)?;

        let length = u32::from_le_bytes([header[0], header[1], header[2], header[3]]);
        let request_id = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
        let message_id = u32::from_le_bytes([header[8], header[9], header[10], header[11]]);
        let message_type = u32::from_le_bytes([header[12], header[13], header[14], header[15]]);

        let mut data = vec![0u8; (length - 12) as usize];
        stream.read_exact(&mut data)?;

        let data = WorkerToHostMessageData::parse_data(message_type, &data)?;

        Ok(WorkerToHostMessage {
            request_id,
            message_id,
            data,
        })
    }
}
