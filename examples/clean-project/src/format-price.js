/** Formats cents as dollars, for example 1250 as "$12.50". */
export function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
