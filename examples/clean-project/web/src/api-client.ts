export interface Item {
  sku: string;
  name: string;
  price: number;
  quantity: number;
}

export async function fetchItems(url: string): Promise<Item[]> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}`);
  return (await response.json()) as Item[];
}

export async function deleteItem(url: string, sku: string): Promise<void> {
  const response = await fetch(`${url}/${encodeURIComponent(sku)}`, { method: "DELETE" });
  if (!response.ok) throw new Error(`DELETE ${sku} failed with ${response.status}`);
}
