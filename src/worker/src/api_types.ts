// Types that are used when communicating with the host, together for easy reference.

// Message types
// Host-to-worker
export enum HostToWorkerMessage {
  /** Run a script, optionally supplying globals and code modules. */
  RunScript = 0,
  /** Host checking connection integrity */
  Ping = 1,
}

// Worker-to-host
export enum WorkerToHostMessage {
  RunResponse = 0x1000,
  Log = 0x1001,
  Error = 0x1002,
  Pong = 0x1003,
}

/** A function to be injected into the context. */
export interface FunctionDef {
  name: string;
  params: string[];
  code: string;
}

/** A ES Module to be importable by the script */
export interface CodeModule {
  name: string;
  code: string;
}

/** Data associated with the RunScript message */
export interface RunScriptArgs {
  name: string;

  /** The code to run. This can be omitted if the message is just initializing the context for later runs. */
  code?: string;

  /** Recreate the run context instead of reusing the context from the previous run on this
   * connection. */
  recreateContext?: boolean;

  /** If true, the code is just a simple expression and should run on its own.
   Expression mode supports returning a value directly, but does not support specifying `modules`. */
  expr?: boolean;

  /** Global variables to set in the context. */
  globals?: object;

  /** How long to wait for the script to complete. */
  timeoutMs?: number;

  /** Functions to compile and place in the global scope */
  functions?: FunctionDef[];

  /** ES Modules to make available for the code to import. */
  modules?: CodeModule[];

  /** If set, return only these keys from the context. If omitted, the entire global context is returned. */
  returnKeys?: string[];
}

export interface RunResponse {
  globals?: object;
  returnValue?: any;
}

export interface ErrorResponse {
  message: string;
  stack?: string;
}

export interface LogMessage {
  level: string;
  message: string | object;
}
