"""TaskBridge — Notion to PostgreSQL Sync Engine.

Bridge your tasks. Synchronize with confidence.
"""

import asyncio
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        import uvicorn.loops.asyncio

        uvicorn.loops.asyncio.asyncio_loop_factory = (  # type: ignore[assignment]
            lambda use_subprocess=False: asyncio.SelectorEventLoop
        )
    except ImportError:
        pass
