// Polyfill for TC39 Math.sumPrecise.
//
// pdf.js v5's font translator calls Math.sumPrecise(). On engines that don't
// ship it yet — and inside the PDF worker, whose global may also lack it or
// have it stripped by a page-level SES lockdown (MetaMask et al.) — the missing
// function makes font translation throw, and the reader renders garbled glyphs
// instead of text. Re-installing the function restores correct rendering.
// No-op where the engine already provides it.

const M = Math as unknown as { sumPrecise?: (values: Iterable<number>) => number };

if (typeof M.sumPrecise !== 'function') {
  // Neumaier compensated summation — precise enough for font metrics while
  // honouring the proposal's special cases (NaN/±Infinity, empty → -0).
  const sumPrecise = (values: Iterable<number>): number => {
    let sum = 0;
    let compensation = 0;
    let count = 0;
    let hasPosInf = false;
    let hasNegInf = false;
    let hasNaN = false;

    for (const v of values) {
      if (typeof v !== 'number') {
        throw new TypeError('Math.sumPrecise: all values must be numbers');
      }
      count++;
      if (v !== v) { hasNaN = true; continue; }
      if (v === Infinity) { hasPosInf = true; continue; }
      if (v === -Infinity) { hasNegInf = true; continue; }
      const t = sum + v;
      compensation += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum;
      sum = t;
    }

    if (hasNaN) return NaN;
    if (hasPosInf && hasNegInf) return NaN;
    if (hasPosInf) return Infinity;
    if (hasNegInf) return -Infinity;
    if (count === 0) return -0;
    return sum + compensation;
  };

  try {
    Object.defineProperty(Math, 'sumPrecise', {
      value: sumPrecise,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  } catch {
    // Math is frozen (e.g. by SES lockdown on the main thread) and cannot be
    // patched here. The worker-side copy of this polyfill is what matters.
  }
}

export {};
