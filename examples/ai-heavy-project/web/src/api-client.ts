export interface Item {
  sku: string;
  name: string;
  price: number;
  quantity: number;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  return (await response.json()) as T;
}

export function getItems(url: string): Promise<Item[]> {
  return fetchJson<Item[]>(url);
}

export function deleteItem(sku: string): Promise<void> {
  throw new Error("Not implemented");
}
