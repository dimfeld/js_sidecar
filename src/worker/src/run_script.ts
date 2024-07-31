import * as vm from 'vm';
import type { MessageContext } from './types.js';
import type { RunScriptArgs } from './api_types.js';

const RUN_CTX_KEY = Symbol('runCtx');

interface RunContext {
  modules: Record<string, vm.Module>;
  context: vm.Context;
}

function createContext(ctx: MessageContext, args: RunScriptArgs): RunContext {
  let runCtx: RunContext = args.recreateContext ? undefined : ctx.protocol.cache.get(RUN_CTX_KEY);

  if (!runCtx) {
    const scriptConsole = {
      log: (...args: any[]) => ctx.log(args, 'info'),
      info: (...args: any[]) => ctx.log(args, 'info'),
      warn: (...args: any[]) => ctx.log(args, 'warn'),
      error: (...args: any[]) => ctx.log(args, 'error'),
    };

    const jsCtx = vm.createContext({
      ...args.globals,
      console: scriptConsole,
    });

    runCtx = {
      modules: {},
      context: jsCtx,
    };

    // Save the context for reuse later.
    ctx.protocol.cache.set(RUN_CTX_KEY, runCtx);
  } else if (args.globals) {
    for (const [key, value] of Object.entries(args.globals)) {
      runCtx.context[key] = value;
    }
  }

  for (const fn of args.functions ?? []) {
    runCtx.context[fn.name] = vm.compileFunction(fn.code, fn.params, {
      parsingContext: runCtx.context,
    });
  }

  for (const modArgs of args.modules ?? []) {
    runCtx.modules[modArgs.name] = new vm.SourceTextModule(modArgs.code, {
      identifier: modArgs.name,
      context: runCtx.context,
    });
  }

  return runCtx;
}

export async function runScript(args: RunScriptArgs, ctx: MessageContext) {
  let run = createContext(ctx, args);

  let retVal;

  if (!args.code) {
    // The user sent no code, this was only to update the context for future runs.
    return {};
  }

  if (args.expr) {
    retVal = vm.runInContext(args.code, run.context, {
      filename: args.name,
      timeout: args.timeoutMs,
    });

    if (typeof retVal?.then === 'function') {
      retVal = await retVal;
    }
  } else {
    async function doLink(specifier: string, referencingModule: vm.Module) {
      const mod = run.modules[specifier];
      if (mod) {
        return mod;
      }

      throw new Error(
        `Module not found: ${specifier}, referenced from ${referencingModule.identifier}`
      );
    }

    let mod = new vm.SourceTextModule(args.code, { identifier: args.name, context: run.context });
    await mod.link(doLink);
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
