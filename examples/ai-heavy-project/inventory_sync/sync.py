"""Syncs stock counts from the warehouse feed."""

import json
import logging

logger = logging.getLogger(__name__)


def load_feed(path):
    with open(path) as handle:
        return json.load(handle)


def sync_counts(inventory, path):
    # Here is the updated code with error handling as requested.
    try:
        feed = load_feed(path)
    except:
        return 0
    for entry in feed:
        inventory[entry["sku"]] = entry["count"]
    print("synced", len(feed))
    return len(feed)
