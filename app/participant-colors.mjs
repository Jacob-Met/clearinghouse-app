// Colors follow first appearance in the recorded plan, never the current row order.
export const PARTICIPANT_PALETTE = Object.freeze([
  "#ff786e", "#60a5ff", "#c1ed67", "#bb99ff", "#ffc65b", "#ff8cc8"
]);

export function participantColors(state) {
  const colors = new Map();
  for (const revision of [...(state?.revisions ?? []), state?.current].filter(Boolean)) {
    for (const member of revision.members ?? []) {
      if (!colors.has(member.id)) colors.set(member.id, PARTICIPANT_PALETTE[colors.size % PARTICIPANT_PALETTE.length]);
    }
  }
  return colors;
}
