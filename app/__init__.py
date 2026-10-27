"""TaskBridge — Notion to PostgreSQL Sync Engine.

Bridge your tasks. Synchronize with confidence.
"""

import asyncio
import sys

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
