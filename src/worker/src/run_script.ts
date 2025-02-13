import * as vm from 'vm';
import type { MessageContext } from './types.js';
import type { RunResponse, RunScriptArgs } from './api_types.js';
import { debug } from './debug.js';
import { LRUCache } from 'lru-cache';

const codeCache = new LRUCache<string, Buffer>({
  max: 128,
});

function codeCacheKey(esm: boolean, code: string, params?: string[]) {
  const startKey = esm ? 'esm' : 'cjs';
  return [startKey, code, ...(params || [])].join('\0');
}

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
    let cacheKey = codeCacheKey(false, fn.code, fn.params);
    let cachedData = codeCache.get(cacheKey);
    let compiled = vm.compileFunction(fn.code, fn.params, {
      parsingContext: runCtx.context,
      cachedData,
      produceCachedData: !cachedData,
    });

    runCtx.context[fn.name] = compiled;
  }

  for (const modArgs of args.modules ?? []) {
    const cacheKey = codeCacheKey(true, modArgs.code);
    let cachedData = codeCache.get(cacheKey);
    let mod = new vm.SourceTextModule(modArgs.code, {
      identifier: modArgs.name,
      context: runCtx.context,
      cachedData,
    });

    if (!cachedData) {
      let data = mod.createCachedData();
      codeCache.set(cacheKey, data);
    }

    runCtx.modules[modArgs.name] = mod;
  }

  return runCtx;
}

export async function runScript(args: RunScriptArgs, ctx: MessageContext): Promise<RunResponse> {
  let start = process.hrtime.bigint();
  let run = createContext(ctx, args);

  let retVal;

  if (!args.code) {
    // The user sent no code, this was only to update the context for future runs.
    return {};
  }

  const cacheKey = codeCacheKey(!args.expr, args.code);
  if (args.expr) {
    let cacheData = codeCache.get(cacheKey);
    let script = new vm.Script(args.code, {
      filename: args.name || '<script>',
      cachedData: cacheData,
    });

    if (!cacheData) {
      codeCache.set(cacheKey, script.createCachedData());
    }

    retVal = script.runInContext(run.context, {
      timeout: args.timeoutMs ?? undefined,
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

    let cachedData = codeCache.get(cacheKey);
    let mod = new vm.SourceTextModule(args.code, {
      identifier: args.name || '<script>',
      context: run.context,
      cachedData,
    });

    if (!cachedData) {
      let data = mod.createCachedData();
      if (data) {
        codeCache.set(cacheKey, data);
      }
    }

    await mod.link(doLink);
    await mod.evaluate();
  }

  const outputGlobals = args.returnKeys
    ? Object.fromEntries(args.returnKeys.map((key) => [key, run.context[key]]))
    : run.context;
  let elapsed = Number(process.hrtime.bigint() - start) / 1e3;
  debug(`Evaluated in ${elapsed}us`);
  return {
    globals: outputGlobals,
    returnValue: retVal,
  };
}
