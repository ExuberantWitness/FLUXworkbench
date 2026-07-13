#!/usr/bin/env python3
"""Spike: SVD → register-map asset, standalone smoke (no studio needed).

Usage:
    brain/.venv/bin/python spike/svd-to-regmap.py brain/vendor/svd/STM32F103xx.svd
    brain/.venv/bin/python spike/svd-to-regmap.py <file.svd> --query USART1
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "brain"))

from flux_brain import svd_ingest  # noqa: E402


def main() -> None:
    if len(sys.argv) < 2:
        print(__doc__, file=sys.stderr)
        raise SystemExit(1)
    svd = sys.argv[1]
    summary = svd_ingest.commit_svd(svd)
    print("committed:", json.dumps(summary, indent=2))

    if "--query" in sys.argv:
        periph = sys.argv[sys.argv.index("--query") + 1]
        sl = svd_ingest.query_regmap(summary["device"], peripheral=periph)
        print(f"\nslice({periph}):", json.dumps(sl, indent=2)[:1500])


if __name__ == "__main__":
    main()
