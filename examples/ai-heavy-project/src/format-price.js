/**
 * Formats a price.
 *
 * Takes a price in cents and returns a formatted string with a
 * currency symbol, so that every screen shows prices the same way.
 *
 * @param {number} cents - The price in cents.
 * @returns {string} The formatted price.
 */
export function formatPrice(cents) {
  return `$${(cents / 100).toFixed(2)}`;
}
