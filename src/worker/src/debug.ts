const enabled = !!process.env.DEBUG_JS_SIDECAR_WORKER;

export function debug(...args: any[]) {
  if (enabled) {
    console.log(...args);
  }
}
