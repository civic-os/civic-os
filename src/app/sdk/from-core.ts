/**
 * Copyright (C) 2023-2026 Civic OS, L3C
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published
 * by the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import { Observable } from 'rxjs';

/**
 * Adapts a Promise-returning core call to a cold Observable, with the same
 * contract an `HttpClient` observable has:
 *
 * - lazy: nothing runs until `subscribe`, and each subscription runs `run` again;
 * - `run` is called synchronously inside `subscribe` (core issues its request
 *   synchronously, so the HTTP request is made in that same tick);
 * - emits once, then completes;
 * - unsubscribing before completion aborts the `AbortSignal` handed to `run`,
 *   which cancels the in-flight request; unsubscribing afterwards does nothing.
 */
export function fromCore<T>(run: (signal: AbortSignal) => Promise<T>): Observable<T> {
  return new Observable<T>(subscriber => {
    const controller = new AbortController();
    let finished = false;
    run(controller.signal).then(
      value => {
        finished = true;
        if (subscriber.closed) return;
        subscriber.next(value);
        subscriber.complete();
      },
      error => {
        finished = true;
        if (subscriber.closed) return;
        subscriber.error(error);
      },
    );
    return () => {
      if (!finished) controller.abort();
    };
  });
}

/**
 * Like {@link fromCore}, for a call that reports progress while it runs
 * (`DataClient.bulkInsert`). `run` receives `emit`, which delivers an interim
 * value synchronously while the call is in flight; the resolved value is
 * emitted last, then the stream completes.
 */
export function fromCoreWithProgress<T>(run: (signal: AbortSignal, emit: (progress: T) => void) => Promise<T>): Observable<T> {
  return new Observable<T>(subscriber => {
    const controller = new AbortController();
    let finished = false;
    run(controller.signal, progress => {
      if (!finished && !subscriber.closed) subscriber.next(progress);
    }).then(
      value => {
        finished = true;
        if (subscriber.closed) return;
        subscriber.next(value);
        subscriber.complete();
      },
      error => {
        finished = true;
        if (subscriber.closed) return;
        subscriber.error(error);
      },
    );
    return () => {
      if (!finished) controller.abort();
    };
  });
}
