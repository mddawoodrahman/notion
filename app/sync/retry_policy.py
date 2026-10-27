from __future__ import annotations

import email.utils
import random
from datetime import UTC, datetime

BASE_MS = 2_000.0
MAX_MS = 15 * 60_000.0  # 15 minutes


def backoff_ms(attempt: int, retry_after_ms: float | None = None) -> float:
    """Calculates exponential backoff with full jitter and honors Retry-After."""
    if attempt <= 0:
        return retry_after_ms or 0.0
    capped = min(BASE_MS * (2.0 ** (attempt - 1)), MAX_MS)
    jittered = random.random() * capped  # full jitter
    return max(jittered, retry_after_ms or 0.0)


def parse_retry_after(header: str | None) -> float | None:
    """
    Parses HTTP Retry-After header (either delta-seconds or HTTP-date).
    Returns delay in milliseconds.
    """
    if not header:
        return None

    # Check if delta-seconds
    try:
        seconds = float(header)
        if seconds >= 0:
            return seconds * 1000.0
    except ValueError:
        pass

    # Check if HTTP-date (e.g. 'Wed, 21 Oct 2026 07:28:00 GMT')
    try:
        dt = email.utils.parsedate_to_datetime(header)
        if dt is not None:
            now = datetime.now(UTC)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=UTC)
            diff_seconds = (dt - now).total_seconds()
            return max(diff_seconds * 1000.0, 0.0)
    except Exception:
        pass

    return None
