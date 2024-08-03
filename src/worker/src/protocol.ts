import net from 'node:net';
import { EventEmitter } from 'node:events';
import { HostToWorkerMessage, WorkerToHostMessage, type RunResponse } from './api_types.js';
import { debug } from './debug.js';

export interface IncomingMessage {
  id: number;
  reqId: number;
  type: HostToWorkerMessage;
  data: Buffer;
}

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
export class Protocol extends EventEmitter<{ message: [IncomingMessage] }> {
  socket: net.Socket;
  buffer: Buffer;
  expectedLength: number | null;
  id: number;

  cache: Map<any, any> = new Map();

  constructor(socket: net.Socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.expectedLength = null;
    this.id = 0;
    this.socket.on('data', (data) => this.handleData(data));
  }

  handleData(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (this.buffer.length > 0) {
      if (this.expectedLength === null) {
        if (this.buffer.length < 4) {
          // Not enough data yet to read length
          return;
        }
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

      const message = {
        id,
        reqId,
        type,
        data,
      };

      // Emit the received message
      this.emit('message', message);
    }
  }

  sendMessage(reqId: number, type: WorkerToHostMessage, message: string | Buffer) {
    debug('Sending message', reqId, type, message);
    if (!(message instanceof Buffer)) {
      message = Buffer.from(message);
    }

    let id = this.id++;
    const header = Buffer.allocUnsafe(MSG_HEADER_LENGTH + 4);
    header.writeUInt32LE(message.length + MSG_HEADER_LENGTH);
    header.writeUInt32LE(reqId, REQ_ID_OFFSET + 4);
    header.writeUInt32LE(id, MSG_ID_OFFSET + 4);
    header.writeUInt32LE(type, MSG_TYPE_OFFSET + 4);

    this.socket.write(Buffer.concat([header, message]));
    return id;
  }

  log(reqId: number, level: string, message: string | object) {
    let data = JSON.stringify({ level, message });
    this.sendMessage(reqId, WorkerToHostMessage.Log, data);
  }

  respond(reqId: number, data: RunResponse) {
    this.sendMessage(reqId, WorkerToHostMessage.RunResponse, JSON.stringify(data));
  }

  error(reqId: number, e: Error) {
    let message = { message: e.message, stack: e.stack };

    let data = JSON.stringify(message);
    this.sendMessage(reqId, WorkerToHostMessage.Error, data);
  }
}
