import test from "node:test";
import assert from "node:assert/strict";
import { formatUsdMinor, updateWeightLabelText } from "../app/ui-utils.mjs";

test("USD minor units retain exact cents across the full safe range", () => {
  assert.equal(formatUsdMinor(0), "$0.00");
  assert.equal(formatUsdMinor(1), "$0.01");
  assert.equal(formatUsdMinor(-1), "-$0.01");
  assert.equal(formatUsdMinor(123456), "$1,234.56");
  assert.equal(formatUsdMinor(Number.MAX_SAFE_INTEGER), "$90,071,992,547,409.91");
  assert.equal(formatUsdMinor(-Number.MAX_SAFE_INTEGER), "-$90,071,992,547,409.91");
  assert.equal(formatUsdMinor(1.5), "Invalid amount");
});

test("renames refresh every weight label by stable member ID without rebuilding controls", () => {
  const ashaTicket = { textContent: "Asha shares" };
  const ashaCoach = { textContent: "Asha shares" };
  const benTicket = { textContent: "Ben shares" };
  const ashaCaptions = [ashaTicket, ashaCoach];
  const benCaptions = [benTicket];

  assert.equal(updateWeightLabelText(ashaCaptions, "Zoe"), 2);
  assert.deepEqual([...ashaCaptions, ...benCaptions].map(caption => caption.textContent), ["Zoe shares", "Zoe shares", "Ben shares"]);

  assert.equal(updateWeightLabelText(benCaptions, "Asha"), 1);
  assert.equal(updateWeightLabelText(ashaCaptions, "Ben"), 2);
  assert.deepEqual([...ashaCaptions, ...benCaptions].map(caption => caption.textContent), ["Ben shares", "Ben shares", "Asha shares"]);
  assert.equal(ashaCaptions[0], ashaTicket);
  assert.equal(ashaCaptions[1], ashaCoach);
  assert.equal(benCaptions[0], benTicket);
});

