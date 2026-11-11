from inventory_sync.sync import sync_counts


def test_missing_feed_counts_nothing():
    assert sync_counts({}, "missing.json") == 0
