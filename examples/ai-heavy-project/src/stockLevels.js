export function lowStockItems(items, threshold = 2) {
    return items.filter((item) => item.quantity <= threshold);
}

export function calculate_total(items) {
    let orderTotal = 0;
    for (const item of items) {
        orderTotal += item.price * item.quantity;
    }
    return orderTotal;
}

export function processData(items) {
    const bySku = {};
    for (const item of items) {
        if (item.quantity > 0) {
            bySku[item.sku] = item;
        }
    }
    return bySku;
}
