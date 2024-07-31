import { describe, it, expect, beforeEach, vi } from 'vitest';
import net from 'net';
import { Protocol } from './protocol';
import { HostToWorkerMessage, WorkerToHostMessage } from './api_types';

describe('Protocol', () => {
  let mockSocket: net.Socket;
  let protocol: Protocol;

  beforeEach(() => {
    mockSocket = {
      on: vi.fn(),
      write: vi.fn(),
    } as unknown as net.Socket;
    protocol = new Protocol(mockSocket);
  });

  it('constructor initializes correctly', () => {
    expect(protocol.buffer).toHaveLength(0);
    expect(protocol.expectedLength).toBeNull();
    expect(protocol.id).toBe(0);
  });

  it('handleData processes complete message', () => {
    const messageListener = vi.fn();
    protocol.on('message', messageListener);

    const message = Buffer.alloc(16);
    message.writeUInt32LE(12, 0); // Length
    message.writeUInt32LE(1, 4); // Request ID
    message.writeUInt32LE(2, 8); // Message ID
    message.writeUInt32LE(HostToWorkerMessage.RunScript, 12); // Message Type

    protocol.handleData(message);

    expect(messageListener).toHaveBeenCalledWith({
      id: 2,
      reqId: 1,
      type: HostToWorkerMessage.RunScript,
      data: Buffer.alloc(0),
    });
  });

  it('handleData processes partial messages', () => {
    const messageListener = vi.fn();
    protocol.on('message', messageListener);

    const part1 = Buffer.alloc(6);
    part1.writeUInt32LE(12, 0); // Length
    part1.writeUInt16LE(1, 4); // Partial Request ID

    const part2 = Buffer.alloc(10);
    part2.writeUInt16LE(0, 0); // Rest of Request ID
    part2.writeUInt32LE(2, 2); // Message ID
    part2.writeUInt32LE(HostToWorkerMessage.RunScript, 6); // Message Type

    protocol.handleData(part1);
    expect(messageListener).not.toHaveBeenCalled();

    protocol.handleData(part2);
    expect(messageListener).toHaveBeenCalledWith({
      id: 2,
      reqId: 1,
      type: HostToWorkerMessage.RunScript,
      data: Buffer.alloc(0),
    });
  });

  it('sendMessage sends correct data', () => {
    const reqId = 1;
    const type = WorkerToHostMessage.RunResponse;
    const message = 'test message';

    protocol.sendMessage(reqId, type, message);

    expect(mockSocket.write).toHaveBeenCalledWith(expect.any(Buffer));

    const writtenBuffer = (mockSocket.write as any).mock.calls[0][0] as Buffer;
    expect(writtenBuffer.readUInt32LE(0)).toBe(message.length + 12); // Total length
    expect(writtenBuffer.readUInt32LE(4)).toBe(reqId);
    expect(writtenBuffer.readUInt32LE(8)).toBe(0); // First message ID
    expect(writtenBuffer.readUInt32LE(12)).toBe(type);
    expect(writtenBuffer.subarray(16).toString()).toBe(message);
  });

  it('log sends correct log message', () => {
    const sendMessageSpy = vi.spyOn(protocol, 'sendMessage');

    protocol.log(1, 'info', 'test log');

    expect(sendMessageSpy).toHaveBeenCalledWith(
      1,
      WorkerToHostMessage.Log,
      JSON.stringify({ level: 'info', message: 'test log' })
    );
  });

  it('respond sends correct response', () => {
    const sendMessageSpy = vi.spyOn(protocol, 'sendMessage');

    protocol.respond(1, { result: 'success' });

    expect(sendMessageSpy).toHaveBeenCalledWith(
      1,
      WorkerToHostMessage.RunResponse,
      JSON.stringify({ result: 'success' })
    );
  });

  it('error sends correct error message', () => {
    const sendMessageSpy = vi.spyOn(protocol, 'sendMessage');
    const error = new Error('Test error');

    protocol.error(1, error);

    expect(sendMessageSpy).toHaveBeenCalledWith(
      1,
      WorkerToHostMessage.Error,
      JSON.stringify({ message: 'Test error', stack: error.stack })
    );
  });
});
