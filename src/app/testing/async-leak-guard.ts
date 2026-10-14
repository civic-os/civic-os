/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

/**
 * Async-leak guard: fails a spec FILE that leaves timers running.
 *
 * Angular's Vitest builder runs with isolate: false, so a timer, interval or
 * immediate started by one spec file keeps running while later files in the
 * same worker execute, and may fire after the worker has started to shut down.
 * A late `console.*` call then makes Vitest fail the whole run with
 * "EnvironmentTeardownError: Closing rpc while "onUserConsoleLog" was
 * pending", attributed to whichever file happened to run last.
 *
 * How it works: one `node:async_hooks` hook per worker records every Timeout
 * (setTimeout/setInterval) and Immediate (setImmediate, and happy-dom's
 * requestAnimationFrame, which is built on it) created while a spec file runs,
 * with its creation stack. A setup-level afterAll (it runs after the file's
 * own afterAll hooks and after every TestBed teardown) waits one macrotask,
 * then fails the file if a timer is still pending (not cleared, not fired, not
 * unref'd) whose own creation stack has a frame in the project's `src/` tree
 * (spec or app code). A polling loop re-arms itself from app code, so its
 * current timer qualifies; the report also shows where the chain of timer
 * callbacks started. Timers created only by Vitest, happy-dom or Angular
 * internals (task-update throttling, AsyncTaskManager bookkeeping after an
 * animation frame, the zoneless scheduler) are ignored even when app code
 * started their chain. The leaked timers are cancelled after being reported so
 * the failure does not cascade into later files. Like the shared-window guard,
 * it only ever adds failures.
 *
 * Not covered: work that outlives the file through a pending promise only (an
 * unawaited dynamic import, for example), or a loop driven purely by library
 * code. scripts/detect-async-leaks.mjs runs Vitest's own detectAsyncLeaks over
 * the whole suite, which tracks promises too, and fails on any leak.
 *
 * See docs/development/TESTING.md, "Async work must not outlive its spec file".
 */

type TimerType = 'Timeout' | 'Immediate';

interface TrackedTimer {
  type: TimerType;
  /** Creation stack; V8 formats it lazily, only for timers that leak. */
  created: Error;
  /** Creation stack of the first timer in a chain of timer callbacks. */
  origin: Error;
  /** The Timeout/Immediate object; weak so tracking never keeps it alive. */
  ref: WeakRef<any>;
}

// Typed loosely: this file is bundled for the Node test runner but compiled
// without Node's type definitions.
interface GuardState {
  timers: Map<number, TrackedTimer>;
  tracking: boolean;
  realSetTimeout: (callback: () => void, ms: number) => unknown;
  realSetImmediate: (callback: () => void) => unknown;
  realClearTimeout: (handle: unknown) => void;
  realClearImmediate: (handle: unknown) => void;
}

const GUARD_FILE = 'src/app/testing/async-leak-guard.ts';
const SETUP_FILE = 'src/test-setup.ts';
const STACK_LIMIT = 100;

/** One hook per worker: the setup file is re-evaluated for every spec file. */
function guardState(): GuardState | null {
  const shared = globalThis as any;
  if (shared.__civicOsAsyncLeakGuard !== undefined) return shared.__civicOsAsyncLeakGuard;

  const nodeProcess = (globalThis as any).process;
  const hooks = nodeProcess?.getBuiltinModule?.('node:async_hooks');
  if (!hooks?.createHook) {
    shared.__civicOsAsyncLeakGuard = null;
    return null;
  }
  // Captured before any spec can install fake timers.
  const state: GuardState = {
    timers: new Map(),
    tracking: false,
    realSetTimeout: shared.setTimeout.bind(globalThis),
    realSetImmediate: shared.setImmediate.bind(globalThis),
    realClearTimeout: shared.clearTimeout.bind(globalThis),
    realClearImmediate: shared.clearImmediate.bind(globalThis),
  };
  hooks.createHook({
    init(asyncId: number, type: string, triggerAsyncId: number, resource: object) {
      if (!state.tracking || (type !== 'Timeout' && type !== 'Immediate')) return;
      const limit = Error.stackTraceLimit;
      Error.stackTraceLimit = STACK_LIMIT;
      const created = new Error('timer created');
      Error.stackTraceLimit = limit;
      const parent = state.timers.get(triggerAsyncId);
      state.timers.set(asyncId, {
        type,
        created,
        origin: parent?.origin ?? created,
        ref: new WeakRef(resource),
      });
    },
    destroy(asyncId: number) {
      state.timers.delete(asyncId);
    },
  }).enable();
  shared.__civicOsAsyncLeakGuard = state;
  return state;
}

/** Stack frames that point into the project's src/ tree (spec or app code). */
function projectFrames(error: Error, srcDir: string): string[] {
  return (error.stack ?? '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line.includes(srcDir) && !line.includes(GUARD_FILE) && !line.includes(SETUP_FILE));
}

function describeTimer(timer: TrackedTimer, frames: string[], originFrames: string[]): string {
  const handle = timer.ref.deref();
  let kind: string = timer.type === 'Immediate' ? 'setImmediate / requestAnimationFrame' : 'setTimeout';
  if (timer.type === 'Timeout' && handle) {
    kind = handle._repeat ? `setInterval(${handle._repeat} ms)` : `setTimeout(${handle._idleTimeout} ms)`;
  }
  const shown = (list: string[]) => list.slice(0, 6).map((f) => `      ${f}`).join('\n');
  let text = `  - ${kind}, created\n${shown(frames)}`;
  if (timer.origin !== timer.created && originFrames.length) {
    text += `\n    in a chain of timer callbacks that started\n${shown(originFrames)}`;
  }
  return text;
}

/**
 * Registers the per-file guard. Call from src/test-setup.ts, which Vitest runs
 * before every spec file, so the afterAll is registered on every file.
 */
export function installAsyncLeakGuard(): void {
  const state = guardState();
  if (!state) return;
  state.timers.clear();
  state.tracking = true;

  afterAll(async () => {
    // Let callbacks that are already due run (e.g. a deferred flush delivery).
    // Tracking stays on meanwhile: a loop (polling, requestAnimationFrame)
    // replaces its pending timer during this wait, and the replacement must
    // still be traced to its origin. The guard's own timers have no src/ frame.
    await new Promise<void>((resolve) => state.realSetTimeout(resolve, 0));
    await new Promise<void>((resolve) => state.realSetImmediate(resolve));
    state.tracking = false;

    const filepath: string = expect.getState().testPath ?? '';
    // The project's src/ directory (absolute), so node_modules/<pkg>/src frames never count.
    const srcIdx = filepath.lastIndexOf('/src/');
    const srcDir = srcIdx >= 0 ? filepath.slice(0, srcIdx + 5) : `${(globalThis as any).process.cwd()}/src/`;
    const leaks: string[] = [];
    const handles: Array<{ type: TimerType; handle: any }> = [];
    for (const timer of state.timers.values()) {
      const handle = timer.ref.deref();
      // Cleared timers stay in the map until Node emits their (batched) destroy
      // hook; Node marks them _destroyed when they are cleared.
      if (!handle || handle._destroyed || !(handle.hasRef?.() ?? false)) continue;
      // Attribution needs a src/ frame in the timer's own creation stack. A
      // timer created only by library or framework code (happy-dom's
      // AsyncTaskManager after an animation frame, Angular's scheduler) is not
      // flagged even when an app timer started its chain: such bookkeeping
      // timers appear while the file settles and are not leaks of their own.
      const frames = projectFrames(timer.created, srcDir);
      if (!frames.length) continue;
      const originFrames = timer.origin === timer.created ? frames : projectFrames(timer.origin, srcDir);
      leaks.push(describeTimer(timer, frames, originFrames));
      handles.push({ type: timer.type, handle });
    }
    state.timers.clear();
    if (!leaks.length) return;

    for (const { type, handle } of handles) {
      if (type === 'Timeout') state.realClearTimeout(handle);
      else state.realClearImmediate(handle);
    }
    const relative = filepath.startsWith(srcDir) ? `src/${filepath.slice(srcDir.length)}` : filepath;
    throw new Error(
      `${relative} left ${leaks.length} timer(s) pending after all its tests and hooks finished. ` +
      `Angular's Vitest runner shares one worker between spec files (isolate: false), so this work would run ` +
      `during later files or after the worker started shutting down. Destroy the fixture (or the code that owns ` +
      `the timer), drive the timer with vi.useFakeTimers() and clear it, or stub the code that starts it. ` +
      `The timers have been cancelled.\n${leaks.join('\n')}`,
    );
  });
}
