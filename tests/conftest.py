import asyncio
import os
import sys

# Ensure APP_ENV=test and NODE_ENV=test are set before any tests or imports execute
os.environ.setdefault("APP_ENV", "test")
os.environ.setdefault("NODE_ENV", "test")

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
