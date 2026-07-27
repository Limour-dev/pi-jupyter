/**
 * Subject — a tiny synchronous multicast Observable.
 *
 * Just enough reactive plumbing for `executionViewChanges$` without pulling in
 * rxjs.  Thread-safe in the single-threaded Node sense: subscribers are called
 * synchronously in registration order.
 */
import type { ObservableLike } from "./types";

export class Subject<T> implements ObservableLike<T> {
  private subscribers = new Set<(value: T) => void>();

  subscribe(next: (value: T) => void): { unsubscribe(): void } {
    this.subscribers.add(next);
    return {
      unsubscribe: () => {
        this.subscribers.delete(next);
      },
    };
  }

  next(value: T): void {
    for (const fn of this.subscribers) fn(value);
  }

  get subscriberCount(): number {
    return this.subscribers.size;
  }
}
