export function createInventory() {
  const itemsBySku = new Map();

  return {
    add(item) {
      itemsBySku.set(item.sku, item);
    },
    list() {
      return [...itemsBySku.values()];
    },
    remove(sku) {
      return itemsBySku.delete(sku);
    },
  };
}
