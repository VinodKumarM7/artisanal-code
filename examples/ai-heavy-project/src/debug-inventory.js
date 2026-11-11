import { createInventory } from "./inventory-service.js";

const inventory = createInventory();
inventory.add({ sku: "T1", name: "Test", price: 1, quantity: 1 });
export const snapshot = inventory.list();
