"""Proxy for main process to call fluxmeme_store.list_assets()."""
import json, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from flux_brain.fluxmeme_store import list_assets
if __name__ != "__main__":
    pass
def list_all():
    return list_assets()
if __name__ == "__main__":
    print(json.dumps(list_all()))
