const LOW_STOCK_THRESHOLD = 2;

export function lowStockItems(items, threshold = LOW_STOCK_THRESHOLD) {
  return items.filter((item) => item.quantity <= threshold);
}

export function stockValue(items) {
  let totalCents = 0;
  for (const item of items) {
    totalCents += item.price * item.quantity;
  }
  return totalCents;
}

export function indexInStockBySku(items) {
  const inStockBySku = {};
  for (const item of items) {
    if (item.quantity > 0) {
      inStockBySku[item.sku] = item;
    }
  }
  return inStockBySku;
}
