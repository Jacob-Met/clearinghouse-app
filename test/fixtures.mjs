import { constants } from "../app/core.mjs";
export const at = (second = 0) => `2026-10-19T08:00:${String(second).padStart(2, "0")}.000Z`;
export function revision(ordinal = 1, overrides = {}) {
  return {
    ordinal, revisionId: `r${ordinal}`, createdAt: at(ordinal), note: `revision ${ordinal}`, policy: constants.POLICY,
    members: [
      { id: "asha", name: "Asha", budgetMinor: 9000 },
      { id: "ben", name: "Ben", budgetMinor: 11000 },
      { id: "chen", name: "Chen", budgetMinor: 8000 }
    ],
    items: [
      { id: "tickets", label: "Tickets", unitMinor: 4000, quantity: 4, weights: [{ memberId: "asha", units: 1 }, { memberId: "ben", units: 2 }, { memberId: "chen", units: 1 }] },
      { id: "coach", label: "Coach", unitMinor: 6000, quantity: 1, weights: [{ memberId: "asha", units: 1 }, { memberId: "ben", units: 1 }, { memberId: "chen", units: 1 }] }
    ],
    ...overrides
  };
}
export const creation = () => ({ projectId: "project-1", title: "Example", eventId: "e1", at: at(0), revision: revision() });
