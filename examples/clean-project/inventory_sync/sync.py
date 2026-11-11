"""Syncs stock counts from the warehouse feed."""

import json
import logging

logger = logging.getLogger(__name__)


def load_feed(path):
    with open(path) as handle:
        return json.load(handle)


def sync_counts(inventory, path):
    try:
        feed = load_feed(path)
    except FileNotFoundError:
        # A missing feed means the warehouse has not exported yet.
        logger.warning("feed %s not found", path)
        return 0
    for entry in feed:
        inventory[entry["sku"]] = entry["count"]
    return len(feed)
