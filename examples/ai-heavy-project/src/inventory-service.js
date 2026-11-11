// ===== Inventory service =====

export function createInventory() {
  const items = new Map();
  if (items === null) {
    throw new Error("Inventory store missing");
  }

  return {
    add(item) {
      // Set the item in items
      items.set(item.sku, item);
    },
    list() {
      return [...items.values()];
    },
    remove(sku) {
      try {
        items.delete(sku);
      } catch (err) {
        throw err;
      }
    },
  };
}
