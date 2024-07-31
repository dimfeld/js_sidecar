import * as vm from 'vm';
import type { MessageContext } from './types.js';

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
  code: string;

  // If true, the code is just a simple expression and should run on its own.
  // Expression mode supports returning a value directly, but does not support specifying `modules`.
  expr?: boolean;

  globals: object;
  timeoutMs?: number;
  functions?: FunctionDef[];
  modules?: CodeModule[];
  /** If set, return only these keys from the context. If omitted, the entire global context is returned. */
  returnKeys?: string[];
}

async function createContext(ctx: MessageContext, args: RunScriptArgs) {
  const console = {
    log: (...args: any[]) => ctx.log(args, 'info'),
    info: (...args: any[]) => ctx.log(args, 'info'),
    warn: (...args: any[]) => ctx.log(args, 'warn'),
    error: (...args: any[]) => ctx.log(args, 'error'),
  };

  const runCtx = vm.createContext({
    ...args.globals,
    console,
  });

  let linkedModules: Record<string, vm.Module> = {};

  async function doLink(specifier: string, referencingModule: vm.Module) {
    if (specifier in linkedModules) {
      return linkedModules[specifier];
    }

    let modArgs = args.modules?.find((m) => m.name === specifier);
    if (modArgs) {
      await createModule(modArgs);
      return linkedModules[specifier];
    }

    throw new Error(
      `Module not found: ${specifier}, referenced from ${referencingModule.identifier}`
    );
  }

  async function createModule(modArgs: CodeModule) {
    if (modArgs.name in linkedModules) {
      // Already did this one
      return;
    }

    let mod = new vm.SourceTextModule(modArgs.code, { identifier: modArgs.name, context: runCtx });
    await mod.link(doLink);
    await mod.evaluate();
    linkedModules[modArgs.name] = mod;
  }

  for (const fn of args.functions ?? []) {
    runCtx[fn.name] = vm.compileFunction(fn.code, fn.params, { parsingContext: runCtx });
  }

  for (const modArgs of args.modules ?? []) {
    createModule(modArgs);
  }

  return { context: runCtx, doLink };
}

export async function runScript(args: RunScriptArgs, ctx: MessageContext) {
  let run = await createContext(ctx, args);

  let retVal;

  if (args.expr) {
    retVal = vm.runInContext(args.code, run.context, {
      filename: args.name,
      timeout: args.timeoutMs,
    });

    if (typeof retVal?.then === 'function') {
      retVal = await retVal;
    }
  } else {
    let mod = new vm.SourceTextModule(args.code, { identifier: args.name, context: run.context });
    await mod.link(run.doLink);
    await mod.evaluate();
  }

  const outputGlobals = args.returnKeys
    ? Object.fromEntries(args.returnKeys.map((key) => [key, run.context[key]]))
    : run.context;
  return {
    globals: outputGlobals,
    returnValue: retVal,
  };
}
