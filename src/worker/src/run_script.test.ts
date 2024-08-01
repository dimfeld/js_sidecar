import { describe, it, expect } from 'vitest';
import type { MessageContext } from './types.js';
import { runScript } from './run_script';
import type { RunScriptArgs } from './api_types.js';

describe('runScript', () => {
  const createMessageContext = (): MessageContext => ({
    protocol: {
      cache: new Map(),
    } as any,
    reqId: 1,
    id: 1,
    log: () => {},
    respond: () => {},
    error: () => {},
  });

  it('should run a simple expression and return its value', async () => {
    const args: RunScriptArgs = {
      name: 'test-expression',
      code: '2 + 2',
      expr: true,
      globals: {},
    };

    const result = await runScript(args, createMessageContext());
    expect(result.returnValue).toBe(4);
  });

  it('should run a script with custom globals', async () => {
    const args: RunScriptArgs = {
      name: 'test-globals',
      code: 'customGlobal + 5',
      expr: true,
      globals: { customGlobal: 10 },
    };

    const result = await runScript(args, createMessageContext());
    expect(result.returnValue).toBe(15);
  });

  it('should run a script with custom functions', async () => {
    const args: RunScriptArgs = {
      name: 'test-functions',
      code: 'customFunction(5)',
      expr: true,
      globals: {},
      functions: [
        {
          name: 'customFunction',
          params: ['x'],
          code: 'return x * 2;',
        },
      ],
    };

    const result = await runScript(args, createMessageContext());
    expect(result.returnValue).toBe(10);
  });

  it('should run a script with custom modules', async () => {
    const args: RunScriptArgs = {
      name: 'test-modules',
      code: `
        import { double } from 'customModule';
        output = await double(5);
      `,
      globals: { output: null },
      modules: [
        // The order of these is important since it ensures that modules can reference each other
        // even when the are passed "out of order."
        {
          name: 'customModule',
          code: `
            import * as fns from 'customModule2';
            export async function double(x) { return fns.double(x); }
          `,
        },
        {
          name: 'customModule2',
          code: 'export function double(x) { return x * 2; }',
        },
      ],
    };

    const result = await runScript(args, createMessageContext());
    expect(result.globals?.output).toBe(10);
  });

  it('should run scripts with cyclic depdendencies in modules', async () => {
    const args: RunScriptArgs = {
      name: 'test-modules',
      code: `
        import { double } from 'customModule';
        output = double(5);
      `,
      globals: { output: null },
      modules: [
        // The order of these is important since it ensures that modules can reference each other
        // even when the are passed "out of order."
        {
          name: 'customModule',
          code: `
            import * as fns from 'customModule2';
            export const multiplier = 2;
            export function double(x) { return fns.double(x); }
          `,
        },
        {
          name: 'customModule2',
          code: `
            import { multiplier } from 'customModule';
            export function double(x) { return x * multiplier; }
          `,
        },
      ],
    };

    const result = await runScript(args, createMessageContext());
    expect(result.globals?.output).toBe(10);
  });

  it('should return specified keys from the context', async () => {
    const args: RunScriptArgs = {
      name: 'test-return-keys',
      code: `
        a = 1;
        b = 2;
        c = 3;
      `,
      globals: { a: null, b: null, c: null },
      returnKeys: ['a', 'b'],
    };

    const result = await runScript(args, createMessageContext());
    expect(result.globals).toEqual({ a: 1, b: 2 });
    expect(result.globals).not.toHaveProperty('c');
  });

  it('should handle async expressions', async () => {
    const args: RunScriptArgs = {
      name: 'test-async-expression',
      code: 'Promise.resolve(42)',
      expr: true,
      globals: {},
    };

    const result = await runScript(args, createMessageContext());
    expect(result.returnValue).toBe(42);
  });

  it('should respect the timeout', async () => {
    const args: RunScriptArgs = {
      name: 'test-timeout',
      code: 'while(true) {}',
      expr: true,
      globals: {},
      timeoutMs: 100,
    };

    await expect(runScript(args, createMessageContext())).rejects.toThrow();
  });

  it('handle script errors in expr mode', async () => {
    const args: RunScriptArgs = {
      name: 'test-error',
      code: 'throw new Error("Test error")',
      expr: true,
      globals: {},
    };

    await expect(runScript(args, createMessageContext())).rejects.toThrow('Test error');
  });

  it('handle script errors in module mode', async () => {
    const args: RunScriptArgs = {
      name: 'test-error',
      code: 'throw new Error("Test error")',
      expr: false,
      globals: {},
    };

    await expect(runScript(args, createMessageContext())).rejects.toThrow('Test error');
  });

  it('reuse context across calls', async () => {
    const ctx = createMessageContext();

    const args: RunScriptArgs = {
      name: 'test-modules',
      code: `
        import { double } from 'customModule';
        output = double(5);
      `,
      globals: { output: null },
      modules: [
        // The order of these is important since it ensures that modules can reference each other
        // even when the are passed "out of order."
        {
          name: 'customModule',
          code: `
            import * as fns from 'customModule2';
            export const multiplier = 2;
            export function double(x) { return fns.double(x); }
          `,
        },
        {
          name: 'customModule2',
          code: `
            import { multiplier } from 'customModule';
            export function double(x) { return x * multiplier; }
          `,
        },
      ],
    };

    const result = await runScript(args, ctx);
    expect(result.globals?.output).toBe(10);

    const args2: RunScriptArgs = {
      name: 'test2',
      code: `
        import { double } from 'customModule';
        output = double(10);
      `,
    };

    const result2 = await runScript(args2, ctx);
    expect(result2.globals?.output).toBe(20);
  });

  it('initialize context and use it later', async () => {
    const ctx = createMessageContext();

    const args: RunScriptArgs = {
      name: 'init',
      globals: { output: null },
      modules: [
        // The order of these is important since it ensures that modules can reference each other
        // even when the are passed "out of order."
        {
          name: 'customModule',
          code: `
            import * as fns from 'customModule2';
            export const multiplier = 2;
            export function double(x) { return fns.double(x); }
          `,
        },
        {
          name: 'customModule2',
          code: `
            import { multiplier } from 'customModule';
            export function double(x) { return x * multiplier; }
          `,
        },
      ],
    };

    await runScript(args, ctx);

    const args2: RunScriptArgs = {
      name: 'test2',
      code: `
        import { double } from 'customModule';
        output = double(10);
      `,
    };

    const result2 = await runScript(args2, ctx);
    expect(result2.globals?.output).toBe(20);
  });

  it('allows two runs with the same name', async () => {
    const ctx = createMessageContext();
    const args: RunScriptArgs = {
      name: 'run',
      globals: { output: null },
      code: `
        import { double } from 'customModule';
        output = double(10);
      `,
      modules: [
        // The order of these is important since it ensures that modules can reference each other
        // even when the are passed "out of order."
        {
          name: 'customModule',
          code: `
            import * as fns from 'customModule2';
            export function double(x) { return fns.double(x); }
          `,
        },
        {
          name: 'customModule2',
          code: `
            import { multiplier } from 'values';
            export function double(x) { return x * multiplier; }
          `,
        },
        {
          name: 'values',
          code: 'export const multiplier = 2;',
        },
      ],
    };

    const result = await runScript(args, ctx);
    expect(result.globals?.output).toBe(20);

    const args2: RunScriptArgs = {
      name: 'run',
      globals: { output: null },
      code: `
        import { double } from 'customModule';
        output = double(20);
      `,
    };

    const result2 = await runScript(args2, ctx);
    expect(result2.globals?.output).toBe(40);
  });
});
