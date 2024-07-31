// Types that are used when communicating with the host, together for easy reference.

// Message types
// Host-to-worker
export enum HostToWorkerMessage {
  /** Run a script, optionally supplying globals and code modules. */
  RunScript = 0,
}

// Worker-to-host
export enum WorkerToHostMessage {
  RunResponse = 0x1000,
  Log = 0x1001,
  Error = 0x1002,
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

export interface RunScriptArgs {
  name: string;
  code?: string;

  /** Recreate the run context instead of reusing the context from the previous run on this
   * connection. */
  recreateContext?: boolean;

  /** If true, the code is just a simple expression and should run on its own.
   Expression mode supports returning a value directly, but does not support specifying `modules`. */
  expr?: boolean;

  globals?: object;
  timeoutMs?: number;
  functions?: FunctionDef[];
  modules?: CodeModule[];
  /** If set, return only these keys from the context. If omitted, the entire global context is returned. */
  returnKeys?: string[];
}
