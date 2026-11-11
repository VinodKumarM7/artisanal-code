import sys

from .sync import sync_counts

if __name__ == "__main__":
    count = sync_counts({}, sys.argv[1])
    print(f"Synced {count} items")
