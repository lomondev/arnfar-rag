"""Put this sidecar's root on sys.path.

Both sidecars ship a top-level package called `app`, so they cannot be collected in one
pytest run — each is invoked from its own directory (see `bun run test:py`). Resolving
the path from this file rather than from pytest's rootdir keeps that working whichever
directory pytest is started in and whichever config file it is handed.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
