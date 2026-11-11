/**
 * @fileoverview Test helper — bound how a function's CPU time grows with its input.
 * @module tests/helpers/cpu-growth
 */

import { expect } from 'vitest';

/** Calls per baseline measurement, so the smallest input still measures well above 1 µs. */
const BASELINE_CALLS = 4;

/** Measurements per size, each paired with a fresh baseline measurement. */
const PAIRS = 3;

/** This thread's CPU time per call over `calls` calls, in ms. */
function cpuMsPerCall(run: () => unknown, calls: number): number {
  const started = process.threadCpuUsage();
  for (let call = 0; call < calls; call++) run();
  const used = process.threadCpuUsage(started);
  return (used.user + used.system) / 1000 / calls;
}

/**
 * Assert that `run(shape(size))` stays linear across a 64× span of sizes starting at `from`.
 *
 * Sizes double, and each is bounded in absolute CPU time before the next one runs, so a quadratic
 * regression fails at the first oversized step instead of hanging on the largest. Every size is
 * measured three times, each beside a fresh measurement of the baseline size — the baseline as a
 * batch of calls, so a sub-millisecond input still measures above the timer's resolution — and its
 * growth is the least of those three pairs, which keeps one slow moment on the machine from failing
 * a linear shape. Linear work grows 64× over the span and quadratic 4096×; the bound is 256.
 *
 * The measure is this thread's CPU time, which other work on the machine does not add to, and each
 * size runs only three times, so a shape's whole check takes a fraction of a second of CPU and stays
 * inside a test's wall-clock timeout while the rest of the suite shares the machine.
 *
 * Returns the measured growth at each size, baseline first.
 */
export function expectLinearGrowth(
  run: (input: string) => unknown,
  shape: (size: number) => string,
  from: number,
): number[] {
  const base = shape(from);
  const growth: number[] = [1];
  for (let size = from * 2; size <= from * 64; size *= 2) {
    const input = shape(size);
    const calls = Math.max(1, Math.round((BASELINE_CALLS * from) / size));
    let least = Number.POSITIVE_INFINITY;
    for (let pair = 0; pair < PAIRS; pair++) {
      const baseMs = cpuMsPerCall(() => run(base), BASELINE_CALLS);
      const sizeMs = cpuMsPerCall(() => run(input), calls);
      expect(sizeMs).toBeLessThan(1_000);
      least = Math.min(least, sizeMs / Math.max(baseMs, 0.001));
    }
    growth.push(least);
  }
  expect(growth.at(-1) as number).toBeLessThan(256);
  return growth;
}
