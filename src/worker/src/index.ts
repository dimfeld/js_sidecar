import cluster from 'cluster';
import os from 'os';
import fs from 'fs';
import { parseArgs } from 'node:util';

import { runWorker } from './worker.js';
import { debug } from './debug.js';

if (cluster.isPrimary) {
  const filename = process.argv[1];

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
  let shuttingDown = false;

  if (!socketPath) {
    throw new Error('No socket path provided');
  }

  process.on('exit', () => {
    // Make sure to clean up the socket file when the process exits
    try {
      fs.unlinkSync(socketPath);
    } catch (e) {}
  });

  function forkWorker() {
    if (shuttingDown) {
      return;
    }

    let worker = cluster.fork({
      SOCKET_PATH: socketPath,
    });

    worker.on('message', (msg) => {
      if (msg === 'ready' && shuttingDown) {
        // We started shutting down between when this worker was forked and when it
        // started listening to messages, so tell it again.
        worker.send('shutdown');
      }
    });
  }

  const shutdown = () => {
    debug('shutting down');
    if (shuttingDown) {
      // Double SIGINT means the shutdown is taking longer than the user wants, so just quit now.
      process.exit(1);
    }

    shuttingDown = true;
    for (let worker of Object.values(cluster.workers ?? {})) {
      worker?.send('shutdown', () => {});
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  cluster.on('online', (worker) => {
    debug('online', worker.process.pid, shuttingDown);
    if (shuttingDown) {
      worker.kill('SIGKILL');
    }
  });

  cluster.on('exit', (worker, code, signal) => {
    debug('exit', worker.process.pid, code, signal, shuttingDown, socketPath);
    if (!shuttingDown && !fs.existsSync(filename)) {
      // This happens when the Rust side shuts down somewhat uncleanly.
      debug(`${socketPath} script is gone, shutting down`);
      shutdown();
    }

    if (shuttingDown) {
      const remainingWorkers = Object.values(cluster.workers ?? {}).map((w) => w?.process.pid);
      debug(socketPath, 'remaining workers:', remainingWorkers);
      if (remainingWorkers.length == 0) {
        process.exit(0);
      }
      return;
    }

    if (signal) {
      debug(`Worker ${worker.process.pid} died with signal ${signal}. Restarting...`);
    } else {
      debug(`Worker ${worker.process.pid} died with code ${code}. Restarting...`);
    }
    forkWorker();
  });

  debug(
    `Primary ${process.pid} is running, starting ${numWorkers} workers and connecting to ${socketPath}`
  );

  for (let i = 0; i < numWorkers; i++) {
    forkWorker();
  }
} else {
  runWorker(process.env.SOCKET_PATH as string);
}
