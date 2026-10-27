from __future__ import annotations

import asyncio
from dataclasses import dataclass
from typing import Any

import httpx

from app.config import AppConfig, get_config
from app.errors import ConfigurationError, NotionApiError, sanitize_error_message
from app.logging_config import logger
from app.sync.retry_policy import backoff_ms, parse_retry_after


@dataclass(frozen=True)
class DataSourcePageBatch:
    results: list[dict[str, Any]]
    next_cursor: str | None = None
    has_more: bool = False
    is_incomplete: bool = False
    incomplete_reason: str | None = None


class NotionSyncClient:
    """Asynchronous Notion API Client with rate-limiting, exponential backoff, and pagination."""

    BASE_URL = "https://api.notion.com/v1"

    def __init__(
        self,
        config: AppConfig | None = None,
        client_override: Any = None,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self.config = config or get_config()
        self.client_override = client_override
        self._external_http_client = http_client
        self._http_client: httpx.AsyncClient | None = None

    async def _get_http_client(self) -> httpx.AsyncClient:
        if self._external_http_client is not None:
            return self._external_http_client
        if self._http_client is None or self._http_client.is_closed:
            self._http_client = httpx.AsyncClient(
                base_url=self.BASE_URL,
                headers={
                    "Authorization": f"Bearer {self.config.NOTION_API_KEY}",
                    "Notion-Version": self.config.NOTION_VERSION,
                    "Content-Type": "application/json",
                },
                timeout=httpx.Timeout(60.0, connect=10.0),
            )
        return self._http_client

    async def close(self) -> None:
        if self._http_client is not None and not self._http_client.is_closed:
            await self._http_client.aclose()
            self._http_client = None

    async def execute_with_retry(self, operation: Any, op_name: str = "notion_api_call") -> Any:
        attempt = 0
        max_attempts = self.config.SYNC_MAX_ATTEMPTS

        while attempt < max_attempts:
            attempt += 1
            try:
                if asyncio.iscoroutinefunction(operation):
                    return await operation()
                res = operation()
                if asyncio.iscoroutine(res):
                    return await res
                return res
            except Exception as err:
                status = getattr(err, "status", None) or getattr(err, "status_code", None)
                if status is None and isinstance(err, httpx.HTTPStatusError):
                    status = err.response.status_code

                retry_after_hdr = None
                headers = getattr(err, "headers", None)
                if headers:
                    if hasattr(headers, "get"):
                        retry_after_hdr = headers.get("retry-after")
                    elif isinstance(headers, dict):
                        retry_after_hdr = headers.get("retry-after")
                elif isinstance(err, httpx.HTTPStatusError):
                    retry_after_hdr = err.response.headers.get("retry-after")

                retry_after_ms = parse_retry_after(retry_after_hdr)

                sanitized = sanitize_error_message(err)
                notion_error = NotionApiError(
                    f"Notion {op_name} failed ({status or 'network'}): {sanitized}",
                    status=status,
                    retry_after_seconds=(retry_after_ms / 1000.0) if retry_after_ms else None,
                    cause=err,
                )

                if not notion_error.is_retryable or attempt >= max_attempts:
                    raise notion_error from err

                wait_ms = backoff_ms(attempt, retry_after_ms)
                logger.warning(
                    "Retrying Notion API call after transient failure",
                    extra={
                        "opName": op_name,
                        "attempt": attempt,
                        "waitMs": wait_ms,
                        "status": status,
                    },
                )
                await asyncio.sleep(wait_ms / 1000.0)

        raise NotionApiError(f"Notion {op_name} failed after {max_attempts} attempts")

    async def resolve_data_source(
        self, database_id: str, configured_data_source_id: str | None = None
    ) -> str:
        # Check client_override first (e.g. for unit tests)
        if self.client_override is not None and hasattr(self.client_override, "databases"):
            db = await self.execute_with_retry(
                lambda: self.client_override.databases.retrieve(database_id=database_id),
                "databases.retrieve",
            )
        else:
            http = await self._get_http_client()

            async def _retrieve_db() -> dict[str, Any]:
                r = await http.get(f"/databases/{database_id}")
                r.raise_for_status()
                return dict(r.json())

            db = await self.execute_with_retry(_retrieve_db, "databases.retrieve")

        data_sources: list[dict[str, Any]] = db.get("data_sources", [])

        if len(data_sources) == 0:
            if configured_data_source_id:
                return configured_data_source_id
            return database_id

        if len(data_sources) == 1 and data_sources[0].get("id"):
            resolved = str(data_sources[0]["id"])
            if configured_data_source_id and configured_data_source_id.replace(
                "-", ""
            ) != resolved.replace("-", ""):
                raise ConfigurationError(
                    f"Resolved data source ID ({resolved}) does not match configured NOTION_DATA_SOURCE_ID ({configured_data_source_id})"
                )
            return resolved

        if not configured_data_source_id:
            names = ", ".join(ds.get("name") or ds.get("id", "") for ds in data_sources)
            raise ConfigurationError(
                f"Database contains multiple data sources ({names}). You must specify NOTION_DATA_SOURCE_ID in configuration."
            )

        match = next(
            (
                ds
                for ds in data_sources
                if ds.get("id", "").replace("-", "") == configured_data_source_id.replace("-", "")
            ),
            None,
        )

        if not match:
            raise ConfigurationError(
                f"Configured NOTION_DATA_SOURCE_ID ({configured_data_source_id}) not found in database data sources"
            )

        return str(match["id"])

    async def query_data_source_pages(
        self,
        data_source_id: str,
        start_cursor: str | None = None,
        page_size: int | None = None,
    ) -> DataSourcePageBatch:
        size = min(max(page_size or self.config.SYNC_PAGE_SIZE, 1), 100)

        # Check client_override
        if self.client_override is not None:
            if hasattr(self.client_override, "dataSources") and hasattr(
                self.client_override.dataSources, "query"
            ):
                res = await self.execute_with_retry(
                    lambda: self.client_override.dataSources.query(
                        data_source_id=data_source_id,
                        start_cursor=start_cursor,
                        page_size=size,
                    ),
                    "dataSources.query",
                )
                return self._to_page_batch(res)
            if hasattr(self.client_override, "databases") and hasattr(
                self.client_override.databases, "query"
            ):
                res = await self.execute_with_retry(
                    lambda: self.client_override.databases.query(
                        database_id=data_source_id,
                        start_cursor=start_cursor,
                        page_size=size,
                    ),
                    "databases.query",
                )
                return self._to_page_batch(res)

        http = await self._get_http_client()
        payload: dict[str, Any] = {"page_size": size}
        if start_cursor:
            payload["start_cursor"] = start_cursor

        async def _query() -> dict[str, Any]:
            # Try data_sources query endpoint first, fall back to databases query endpoint
            r = await http.post(f"/data_sources/{data_source_id}/query", json=payload)
            if r.status_code == 404:
                r = await http.post(f"/databases/{data_source_id}/query", json=payload)
            r.raise_for_status()
            return dict(r.json())

        res = await self.execute_with_retry(_query, "dataSources.query")
        return self._to_page_batch(res)

    def _to_page_batch(self, res: dict[str, Any]) -> DataSourcePageBatch:
        request_status = res.get("request_status")
        is_incomplete = (
            isinstance(request_status, dict) and request_status.get("type") == "incomplete"
        )

        return DataSourcePageBatch(
            results=res.get("results", []),
            next_cursor=res.get("next_cursor"),
            has_more=bool(res.get("has_more")),
            is_incomplete=is_incomplete,
            incomplete_reason=(
                request_status.get("incomplete_reason")
                if is_incomplete and isinstance(request_status, dict)
                else None
            ),
        )

    async def fetch_page(self, page_id: str) -> dict[str, Any]:
        if self.client_override is not None and hasattr(self.client_override, "pages"):
            res = await self.execute_with_retry(
                lambda: self.client_override.pages.retrieve(page_id=page_id),
                "pages.retrieve",
            )
            return dict(res)

        http = await self._get_http_client()

        async def _fetch() -> dict[str, Any]:
            r = await http.get(f"/pages/{page_id}")
            r.raise_for_status()
            return dict(r.json())

        raw_page = await self.execute_with_retry(_fetch, "pages.retrieve")
        return dict(raw_page)

    async def fetch_page_blocks(self, block_id: str, max_depth: int = 3) -> list[dict[str, Any]]:
        if max_depth <= 0:
            return []

        blocks: list[dict[str, Any]] = []
        cursor: str | None = None
        has_more = True

        while has_more:
            if self.client_override is not None and hasattr(self.client_override, "blocks"):
                res_obj = await self.execute_with_retry(
                    lambda c=cursor: self.client_override.blocks.children.list(
                        block_id=block_id,
                        start_cursor=c,
                        page_size=100,
                    ),
                    "blocks.children.list",
                )
                response = dict(res_obj)
            else:
                http = await self._get_http_client()
                params: dict[str, Any] = {"page_size": 100}
                if cursor:
                    params["start_cursor"] = cursor

                async def _list_children(
                    p: dict[str, Any] = params, client: httpx.AsyncClient = http
                ) -> dict[str, Any]:
                    r = await client.get(f"/blocks/{block_id}/children", params=p)
                    r.raise_for_status()
                    return dict(r.json())

                raw_children = await self.execute_with_retry(_list_children, "blocks.children.list")
                response = dict(raw_children)

            for block in response.get("results", []):
                if block.get("has_children") and max_depth > 1:
                    children = await self.fetch_page_blocks(block["id"], max_depth - 1)
                    block_copy = dict(block)
                    block_copy["children"] = children
                    blocks.append(block_copy)
                else:
                    blocks.append(block)

            has_more = bool(response.get("has_more"))
            cursor = response.get("next_cursor")

        return blocks
