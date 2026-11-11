import { test } from "node:test";
import assert from "node:assert/strict";
import { indexInStockBySku, lowStockItems, stockValue } from "./stock-levels.js";

const items = [
  { sku: "A1", price: 120, quantity: 3 },
  { sku: "B2", price: 450, quantity: 0 },
];

test("stock value multiplies price by quantity", () => {
  assert.equal(stockValue(items), 360);
});

test("items at or below the threshold are low on stock", () => {
  assert.deepEqual(lowStockItems(items).map((item) => item.sku), ["B2"]);
});

test("only items in stock are indexed", () => {
  assert.deepEqual(Object.keys(indexInStockBySku(items)), ["A1"]);
});
