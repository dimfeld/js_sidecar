import net from 'net';
import cluster from 'cluster';
import { Protocol, type IncomingMessage } from './protocol.js';
import type { MessageContext } from './types.js';
import { runScript } from './run_script.js';
import { HostToWorkerMessage } from './api_types.js';
import { debug } from './debug.js';

export function runWorker(socketPath: string) {
  debug(`Worker ${process.pid} started`);
  const server = net.createServer();
  const shutdown = () => {
    debug(`Worker ${process.pid} is shutting down`);
    server.close(() => process.exit(0));
  };

  process.on('message', (msg) => {
    debug(`Worker ${process.pid} received message: ${msg}`);
    if (msg == 'shutdown') {
      debug(`Worker ${process.pid} received shutdown message`);
      shutdown();
    }
  });

  cluster.worker?.send('ready');

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  function accept(socket: net.Socket) {
    let protocol = new Protocol(socket);
    protocol.on('message', (message) => handleRawMessage(protocol, message));
  }

  server.on('error', (e) => {
    debug(e);
    process.exit(1);
  });

  server.listen(socketPath, () => {
    debug(`Worker ${process.pid} is listening on ${socketPath}`);
    server.on('connection', accept);
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
      protocol.respond(reqId, data);
    },
    error(e: Error) {
      debug(`${reqId}: `, e);
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
      debug('Failed to handle request:');
      context.error(e.message);
    });
}

async function handleMessage(
  ctx: MessageContext,
  type: HostToWorkerMessage,
  data: Buffer
): Promise<any> {
  switch (type) {
    case HostToWorkerMessage.RunScript: {
      return runScript(JSON.parse(data.toString()), ctx);
    }
  }
}
