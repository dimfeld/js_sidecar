import cluster from 'cluster';
import net from 'net';
import os from 'os';
import fs from 'fs';
import { parseArgs } from 'node:util';

// Parse command line arguments
const { values } = parseArgs({
  options: {
    workers: {
      type: 'string',
      short: 'w',
      default: os.cpus().length.toString(),
    },
    socket: {
      type: 'string',
      short: 's',
    },
  },
});

const numWorkers = parseInt(values.workers, 10);
const socketPath = values.socket;

if(!socketPath) {
  throw new Error('No socket path provided');
}

if (cluster.isPrimary) {
  console.log(`Primary ${process.pid} is running`);

  // Create the Unix socket
  const server = net.createServer();

  // Listen on the Unix socket
  server.listen(socketPath, () => {
    console.log(`Primary is listening on ${socketPath}`);
  });

  // Function to fork a new worker
  const forkWorker = () => {
    const worker = cluster.fork();
    worker.send('server', server);
    return worker;
  };

  // Fork workers
  for (let i = 0; i < numWorkers; i++) {
    forkWorker();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.error(`Worker ${worker.process.pid} died with code ${code}. Restarting...`);
    forkWorker();
  });
} else {
  console.log(`Worker ${process.pid} started`);

  // Receive the server handle from the primary
  process.on('message', (msg, server) => {
    if (msg === 'server') {
      server.on('connection', (socket) => {
        let protocol = new Protocol(socket);
        protocol.on('message', (message) => handleRawMessage(protocol, message));
      });
    }
  });
}

// Cleanup: remove the socket file when the process exits
process.on('exit', () => {
  if (cluster.isPrimary) {
    fs.unlinkSync(socketPath);
  }
});


// Message types
const MSG_RUN_REQUEST = 0;
const MSG_RUN_RESPONSE = 1;
const MSG_LOG = 2;
const MSG_ERROR = 3;

// Header *without* the length field
const MSG_HEADER_LENGTH = 12;

// Offsets from just after the length field.
const REQ_ID_OFFSET = 0;
const MSG_ID_OFFSET = 4;
const MSG_TYPE_OFFSET = 8;

/** A simple protocol in which each message has an ID, a type, and some data
 *
 *  Format
 *
 *  0: length
 *  4: request ID, links the message to a particular run
 *  8: message ID, unique per message within a request
 *  12: message type
 *  ... type-specific data follows
 * */
class Protocol extends EventEmitter{
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.id = 0;
    this.socket.on('data', (data) => this.handleData(data));
  }

  handleData(data) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length > 0) {
      if (this.expectedLength === null) {
        if (this.buffer.length < 4) return; // Not enough data to read length
        this.expectedLength = this.buffer.readUInt32LE(0);
        this.buffer = this.buffer.subarray(4);
      }

      // Not enough data for full message
      if (this.buffer.length < this.expectedLength) {
        return;
      }

      const reqId = this.buffer.readUInt32LE(REQ_ID_OFFSET);
      const id = this.buffer.readUInt32LE(MSG_ID_OFFSET);
      const type = this.buffer.readUInt32LE(MSG_TYPE_OFFSET);
      const data = this.buffer.subarray(12, this.expectedLength);

      // Remove the message from the pending buffer
      this.buffer = this.buffer.subarray(this.expectedLength);
      this.expectedLength = null;

      const message =  {
        id,
        reqId,
        type,
        data,
      };

      // Emit the received message
      this.emit('message', message);
    }
  }

  sendMessage(reqId, type, message) {
    let id = this.id++;
    const header = Buffer.allocUnsafe(MSG_HEADER_LENGTH + 4);
    header.writeUInt32LE(message.length + MSG_HEADER_LENGTH);
    header.writeUInt32LE(reqId, REQ_ID_OFFSET + 4);
    header.writeUInt32LE(id, MSG_ID_OFFSET + 4);
    header.writeUInt32LE(type, MSG_TYPE_OFFSET + 4);

    if(!(message instanceof Buffer)) {
      message = Buffer.from(message);
    }

    this.socket.write(Buffer.concat([header, message]));
    return id;
  }

  log(reqId, level, message) {
    let data = JSON.stringify({ level, message });
    this.sendMessage(reqId, MSG_LOG, data);
  }

  respond(reqId, data) {
    this.sendMessage(reqId, MSG_RUN_RESPONSE, data);
  }

  error(reqId, e) {
    let message = e;
    if(message instanceof Error) {
      message =  { message: e.message, stack: e.stack };
    }

    let data = JSON.stringify(message);
    this.sendMessage(reqId, MSG_ERROR, data);
  }
}

function handleRawMessage(protocol, { id, reqId, type, data }) {

  let sentResponse = false;
  const context = {
    protocol,
    reqId,
    id,
    log(message, level="info") {
      console[level](`${reqId}: `, message)
      protocol.log(reqId, level, message);
    },
    respond(data) {
      sentResponse = true;
      protocol.respond(reqId, JSON.stringify(data ?? null));
    },
    error(e) {
      console.error(`${reqId}: `, e);
      protocol.error(reqId, e);
    },
  };

  handleMessage(context, type, data)
    .then((response) => {
      if(response != undefined || !sentResponse) {
        context.respond(response ?? null);
      }
    })
    .catch((e) => {
      console.error('Failed to handle request:');
      context.error(e.message);
    });
}



function handleMessage(ctx, type, data) {

}
