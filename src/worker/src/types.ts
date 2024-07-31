import type { Protocol } from './protocol.js';

export interface MessageContext {
  protocol: Protocol;
  reqId: number;
  id: number;
  log(message: any, level?: keyof Console): void;
  respond(data: any): void;
  error(e: Error): void;
}
