import { createInventory } from "./inventory.js";
import { formatPrice } from "./format-price.js";
import { lowStockItems, stockValue } from "./stock-levels.js";

const inventory = createInventory();
inventory.add({ sku: "A1", name: "Pen", price: 120, quantity: 3 });
inventory.add({ sku: "B2", name: "Pad", price: 450, quantity: 0 });

const items = inventory.list();
console.log(`Stock value: ${formatPrice(stockValue(items))}`);
console.log(`Low stock: ${lowStockItems(items).map((item) => item.name).join(", ")}`);
