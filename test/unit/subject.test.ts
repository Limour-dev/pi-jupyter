/**
 * Unit tests: the tiny Subject observable.
 */
import { describe, expect, it, vi } from "vitest";
import { Subject } from "../../src/domain/subject";

describe("Subject", () => {
  it("delivers values to subscribers", () => {
    const s = new Subject<number>();
    const seen: number[] = [];
    s.subscribe((v) => seen.push(v));
    s.next(1);
    s.next(2);
    expect(seen).toEqual([1, 2]);
  });

  it("multicasts to multiple subscribers", () => {
    const s = new Subject<string>();
    const a = vi.fn();
    const b = vi.fn();
    s.subscribe(a);
    s.subscribe(b);
    s.next("x");
    expect(a).toHaveBeenCalledWith("x");
    expect(b).toHaveBeenCalledWith("x");
  });

  it("stops delivering after unsubscribe", () => {
    const s = new Subject<number>();
    const fn = vi.fn();
    const sub = s.subscribe(fn);
    s.next(1);
    sub.unsubscribe();
    s.next(2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("tracks subscriber count", () => {
    const s = new Subject<void>();
    const a = s.subscribe(() => {});
    const b = s.subscribe(() => {});
    expect(s.subscriberCount).toBe(2);
    a.unsubscribe();
    expect(s.subscriberCount).toBe(1);
    b.unsubscribe();
    expect(s.subscriberCount).toBe(0);
  });
});
