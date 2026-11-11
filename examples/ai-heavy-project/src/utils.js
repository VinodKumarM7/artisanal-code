export const sumBy = (list, pick) => list.reduce((total, entry) => total + pick(entry), 0);

export function groupBy(list, pick) {
  const result = {};
  for (const entry of list) {
    (result[pick(entry)] ??= []).push(entry);
  }
  return result;
}

export function chunkList(list, size) {
  const chunks = [];
  for (let i = 0; i < list.length; i += size) chunks.push(list.slice(i, i + size));
  return chunks;
}

export const uniqueValues = (list) => [...new Set(list)];

// This function capitalizes the first letter of a word.
export const capitalizeWord =(word) => word.charAt(0).toUpperCase() + word.slice(1);

export const waitFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
