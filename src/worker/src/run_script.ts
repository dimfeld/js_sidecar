import * as vm from 'vm';
import type { MessageContext } from './types.js';
import type { CodeModule, RunScriptArgs } from './api_types.js';

async function createContext(ctx: MessageContext, args: RunScriptArgs) {
  const scriptConsole = {
    log: (...args: any[]) => ctx.log(args, 'info'),
    info: (...args: any[]) => ctx.log(args, 'info'),
    warn: (...args: any[]) => ctx.log(args, 'warn'),
    error: (...args: any[]) => ctx.log(args, 'error'),
  };

  const runCtx = vm.createContext({
    ...args.globals,
    console: scriptConsole,
  });

  for (const fn of args.functions ?? []) {
    runCtx[fn.name] = vm.compileFunction(fn.code, fn.params, { parsingContext: runCtx });
  }

  let modules: Record<string, vm.Module> = {};
  for (const modArgs of args.modules ?? []) {
    modules[modArgs.name] = new vm.SourceTextModule(modArgs.code, {
      identifier: modArgs.name,
      context: runCtx,
    });
  }

  async function doLink(specifier: string, referencingModule: vm.Module) {
    const mod = modules[specifier];
    if (mod) {
      return mod;
    }

    throw new Error(
      `Module not found: ${specifier}, referenced from ${referencingModule.identifier}`
    );
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
