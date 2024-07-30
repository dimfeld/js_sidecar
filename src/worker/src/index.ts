import cluster from 'cluster';
import os from 'os';
import fs from 'fs';
import { parseArgs } from 'node:util';

import { runWorker } from './worker.js';

if (cluster.isPrimary) {
  // Parse command line arguments
  const { values } = parseArgs({
    options: {
      workers: {
        type: 'string',
        default: os.cpus().length.toString(),
      },
      socket: {
        type: 'string',
      },
    },
  });

  const numWorkers = parseInt(values.workers ?? '1', 10);
  const socketPath = values.socket;

  if (!socketPath) {
    throw new Error('No socket path provided');
  }

  console.log(`Primary ${process.pid} is running`);

  // Clean up the socket file when the process exits in case
  process.on('exit', () => {
    try {
      fs.unlinkSync(socketPath);
    } catch (e) {}
  });

  function forkWorker() {
    cluster.fork({
      SOCKET_PATH: socketPath,
    });
  }

  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) {
      // Double SIGINT means the shutdown is taking longer than the user wants, so just quit now.
      process.exit(1);
    }

    shuttingDown = true;
    for (let worker of Object.values(cluster.workers ?? {})) {
      worker?.send('shutdown');
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      if (Object.keys(cluster.workers ?? {}).length == 0) {
        process.exit(0);
      }
      return;
    }

    if (signal) {
      console.error(`Worker ${worker.process.pid} died with signal ${signal}. Restarting...`);
    } else {
      console.error(`Worker ${worker.process.pid} died with code ${code}. Restarting...`);
    }
    forkWorker();
  });

  for (let i = 0; i < numWorkers; i++) {
    forkWorker();
  }
} else {
  runWorker(process.env.SOCKET_PATH as string);
}
