export function formatUsdMinor(minor) {
  if (!Number.isSafeInteger(minor)) return "Invalid amount";
  const value = BigInt(minor); const negative = value < 0n; const absolute = negative ? -value : value;
  const dollars = (absolute / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = (absolute % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}$${dollars}.${cents}`;
}

export function updateWeightLabelText(captions, memberName) {
  for (const caption of captions) {
    caption.textContent = `${memberName} shares`;
  }
  return captions.length;
}


// Form amounts are USD decimal text; the domain continues to use exact cents.
export function usdInputToMinor(text) {
  const value = String(text).trim();
  if (!/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(value)) return Number.NaN;
  const [whole, fraction = ""] = value.split(".");
  const minor = BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0"));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : Number.NaN;
}
export function minorToUsdInput(minor) {
  if (!Number.isSafeInteger(minor) || minor < 0) return "";
  const value = BigInt(minor);
  return (value / 100n).toString() + "." + (value % 100n).toString().padStart(2, "0");
}
