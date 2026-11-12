// Browser-session evidence, accepted only after checking the exact provider order.
export function matchesPreparedSandboxOrder(entry, order, revisionId) {
  if (!entry || !order || typeof revisionId !== "string" ||
      !Number.isSafeInteger(entry.amountMinor) || entry.amountMinor <= 0 ||
      order.memberId !== entry.id || order.orderId !== entry.orderId ||
      order.revisionId !== revisionId || order.amount !== entry.amount ||
      typeof order.captured !== "boolean") return false;
  // A completed order alone does not establish completed capture.
  return !order.captured || (order.status === "COMPLETED" &&
    order.captureStatus === "COMPLETED" && /^[A-Za-z0-9]{8,36}$/.test(order.captureId || ""));
}

export function summarizeSandboxChecks(members, checks) {
  const payable = members.filter(member => Number.isSafeInteger(member.amountMinor) && member.amountMinor > 0);
  let inspected = 0, captured = 0, total = 0n;
  for (const member of payable) {
    const observed = checks?.get(member.id);
    if (!observed || observed.amountMinor !== member.amountMinor) continue;
    inspected++;
    if (observed.captured === true) {
      captured++;
      total += BigInt(member.amountMinor);
    }
  }
  return { payable: payable.length, inspected, captured, totalMinor: Number(total) };
}

// The group endpoint verifies its saved order bindings against PayPal. Use the
// same returned evidence for the headline and ledger, including payments first
// discovered through a group check rather than an individual payer button.
export function checksFromGroupReconciliation(members, reconciliation, revisionId) {
  const checks = new Map();
  if (reconciliation.revisionId !== revisionId) return checks;
  for (const member of members) {
    if (!Number.isSafeInteger(member.amountMinor) || member.amountMinor <= 0) continue;
    const order = reconciliation.members.find(row => row.memberId === member.id);
    if (!order?.orderId) continue; // Missing/unavailable orders establish no capture evidence.
    const cents = BigInt(member.amountMinor);
    const entry = {
      id: member.id, amountMinor: member.amountMinor, orderId: order.orderId,
      amount: (cents / 100n).toString() + "." + (cents % 100n).toString().padStart(2, "0")
    };
    if (matchesPreparedSandboxOrder(entry, order, revisionId))
      checks.set(member.id, {amountMinor: member.amountMinor, captured: order.captured});
  }
  return checks;
}
