import { deleteItem, fetchItems } from "./api-client";

const shownItems = await fetchItems("/api/items");
document.title = `${shownItems.length} items`;

document.querySelector("#clear")?.addEventListener("click", async () => {
  await Promise.all(shownItems.map((item) => deleteItem("/api/items", item.sku)));
});
