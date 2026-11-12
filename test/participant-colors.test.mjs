import test from "node:test";
import assert from "node:assert/strict";
import { participantColors, PARTICIPANT_PALETTE } from "../app/participant-colors.mjs";

const members = "abcdef".split("").map(id => ({ id }));
test("six-person colors survive reorder, departure and rejoining", () => {
  const first = { members };
  const before = participantColors({ revisions: [first], current: first });
  assert.equal(new Set(before.values()).size, 6);
  const revised = { members: [members[5], members[2], members[0]] };
  const after = participantColors({ revisions: [first, revised], current: revised });
  for (const member of members) assert.equal(after.get(member.id), before.get(member.id));
  const rejoined = { members: [...revised.members, members[1], { id: "new" }] };
  const final = participantColors({ revisions: [first, revised], current: rejoined });
  assert.equal(final.get("b"), before.get("b"));
  assert.equal(final.get("new"), PARTICIPANT_PALETTE[0]);
});
