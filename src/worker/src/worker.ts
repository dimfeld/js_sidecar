import net from 'net';
import { HostToWorkerMessage, Protocol, type IncomingMessage } from './protocol.js';
import type { MessageContext } from './types.js';
import { runScript } from './run_script.js';

export function runWorker(socketPath: string) {
  console.log(`Worker ${process.pid} started`);
  const server = net.createServer();
  const shutdown = () => {
    console.log(`Worker ${process.pid} is shutting down`);
    server.close(() => process.exit(0));
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  function accept(socket: net.Socket) {
    let protocol = new Protocol(socket);
    protocol.on('message', (message) => handleRawMessage(protocol, message));
  }

  server.on('error', (e) => {
    console.error(e);
    process.exit(1);
  });

  server.listen(socketPath, () => {
    console.log(`Worker ${process.pid} is listening on ${socketPath}`);
    server.on('connection', accept);
  });

  process.on('message', (msg) => {
    if (msg == 'shutdown') {
      shutdown();
    }
  });
}

function handleRawMessage(protocol: Protocol, { id, reqId, type, data }: IncomingMessage) {
  let sentResponse = false;
  const context: MessageContext = {
    protocol,
    reqId,
    id,
    log(message: any, level: keyof Console = 'info') {
      // @ts-expect-error More complex type definition for `level` param would fix this
      console[level](`${reqId}: `, message);
      protocol.log(reqId, level, message);
    },
    respond(data: any) {
      sentResponse = true;
      protocol.respond(reqId, JSON.stringify(data ?? null));
    },
    error(e: Error) {
      console.error(`${reqId}: `, e);
      protocol.error(reqId, e);
    },
  };

  handleMessage(context, type, data)
    .then((response) => {
      if (response != undefined || !sentResponse) {
        context.respond(response ?? null);
      }
    })
    .catch((e) => {
      console.error('Failed to handle request:');
      context.error(e.message);
    });
}

async function handleMessage(
  ctx: MessageContext,
  type: HostToWorkerMessage,
  data: Buffer
): Promise<any> {
  switch (type) {
    case HostToWorkerMessage.RunRequest: {
      return runScript(JSON.parse(data.toString()), ctx);
    }
  }
}
