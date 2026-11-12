import test from "node:test";
import assert from "node:assert/strict";
import { usdInputToMinor, minorToUsdInput } from "../app/ui-utils.mjs";
test("organizer dollar input preserves cents without rounding or assuming missing money", () => {
  for (const [text, cents] of [["27.50", 2750], ["90", 9000], [".05", 5], ["0.29", 29], ["0", 0], [" 60.00 ", 6000]]) {
    assert.equal(usdInputToMinor(text), cents);
    assert.equal(usdInputToMinor(minorToUsdInput(cents)), cents);
  }
  for (const text of ["", " ", "1.005", "-1", "1e2", "ninety", "90071992547409.92"]) assert.equal(Number.isNaN(usdInputToMinor(text)), true, text);
  assert.equal(minorToUsdInput(Number.NaN), "");
  assert.equal(usdInputToMinor("90071992547409.91"), Number.MAX_SAFE_INTEGER);
});
