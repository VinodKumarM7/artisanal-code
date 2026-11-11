import { createInventory } from "./inventory-service.js";
import { formatPrice } from "./format-price.js";
import { groupBy, sumBy } from "./utils.js";
import { lowStockItems } from "./stockLevels.js";

const REPORT_OPTIONS = { label: "Stock value" };

const inventory = createInventory();
inventory.add({ sku: "A1", name: "Pen", price: 120, quantity: 3 });
inventory.add({ sku: "B2", name: "Pad", price: 450, quantity: 0 });

const items = inventory.list();
console.log("DEBUG items:", items);
const stockValue = sumBy(items, (item) => item.price * item.quantity);
console.log(`${REPORT_OPTIONS.label}: ${formatPrice(stockValue)}`);
console.log(`Low stock: ${lowStockItems(items).length} of ${Object.keys(groupBy(items, (item) => item.sku)).length}`);
