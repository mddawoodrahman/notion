from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any

from fastapi import APIRouter, Header, Request, status
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from app.config import AppConfig, get_config
from app.db.inbox_repo import InboxEventInput, InboxRepository
from app.logging_config import logger

router = APIRouter()

SIGNATURE_PREFIX = "sha256="
SHA256_HEX_LENGTH = 64
MAX_WEBHOOK_BODY_BYTES = 256 * 1024  # 256 KiB limit per SPEC §8.3


class WebhookEntity(BaseModel):
    type: str | None = None
    id: str | None = None


class WebhookEnvelope(BaseModel):
    id: str = Field(min_length=1)
    type: str = Field(min_length=1)
    entity: WebhookEntity | None = None
    timestamp: str | None = None

    model_config = ConfigDict(extra="allow")


def verify_webhook_signature(body: bytes, signature: str | None, verification_token: str) -> bool:
    """Verifies HMAC-SHA256 signature using constant-time comparison."""
    if not isinstance(signature, str):
        return False
    if not signature.startswith(SIGNATURE_PREFIX):
        return False

    provided_hex = signature[len(SIGNATURE_PREFIX) :].lower()
    if len(provided_hex) != SHA256_HEX_LENGTH:
        return False
    if not all(c in "0123456789abcdef" for c in provided_hex):
        return False

    computed_hex = hmac.new(
        verification_token.encode("utf-8"),
        body,
        hashlib.sha256,
    ).hexdigest()

    return hmac.compare_digest(provided_hex, computed_hex)


def sign_webhook_payload(body: bytes | str, verification_token: str) -> str:
    """Computes the signature header Notion would send for a given payload and token."""
    body_bytes = body.encode("utf-8") if isinstance(body, str) else body
    computed_hex = hmac.new(
        verification_token.encode("utf-8"),
        body_bytes,
        hashlib.sha256,
    ).hexdigest()
    return f"{SIGNATURE_PREFIX}{computed_hex}"


@router.post("/webhooks/notion")
async def notion_webhook_receiver(
    request: Request,
    x_notion_signature: str | None = Header(None, alias="x-notion-signature"),
) -> JSONResponse:
    raw_body = await request.body()

    if len(raw_body) > MAX_WEBHOOK_BODY_BYTES:
        return JSONResponse(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            content={"ok": False, "error": "payload_too_large"},
        )

    # Parse JSON if possible
    body: dict[str, Any] | None = None
    if raw_body:
        try:
            parsed = json.loads(raw_body.decode("utf-8"))
            if isinstance(parsed, dict):
                body = parsed
        except Exception:
            body = None

    config: AppConfig = getattr(request.app.state, "config", None) or get_config()
    pool = getattr(request.app.state, "pool", None)

    # 1. One-time verification handshake check (SPEC §8.1)
    if body and isinstance(body.get("verification_token"), str) and not body.get("type"):
        token = body["verification_token"]
        last4 = token[-4:] if len(token) >= 4 else token
        logger.warning(
            "Received Notion webhook verification token handshake",
            extra={"tokenSuffix": f"***{last4}"},
        )
        return JSONResponse(status_code=status.HTTP_200_OK, content={"ok": True})

    # 2. Verification token availability (SEC-001): fail closed unless explicitly opted out
    verification_token = config.NOTION_WEBHOOK_VERIFICATION_TOKEN
    allow_unsigned = config.ALLOW_UNSIGNED_WEBHOOKS

    if not verification_token and not allow_unsigned:
        logger.error("Rejecting webhook: NOTION_WEBHOOK_VERIFICATION_TOKEN is not configured")
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"ok": False})

    # 3. Signature verification (SPEC §8.2)
    if verification_token:
        if not x_notion_signature:
            logger.warning(
                "Rejected webhook delivery: missing X-Notion-Signature",
                extra={"ip": request.client.host if request.client else "unknown"},
            )
            return JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"ok": False})

        try:
            is_valid = verify_webhook_signature(raw_body, x_notion_signature, verification_token)
            if not is_valid:
                logger.warning(
                    "Rejected webhook delivery: signature verification failed",
                    extra={"ip": request.client.host if request.client else "unknown"},
                )
                return JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"ok": False})
        except Exception as err:
            logger.error(
                "Error executing webhook signature verification",
                extra={"err": str(err), "ip": request.client.host if request.client else "unknown"},
            )
            return JSONResponse(status_code=status.HTTP_401_UNAUTHORIZED, content={"ok": False})
    else:
        logger.warning(
            "Accepting unsigned webhook delivery because ALLOW_UNSIGNED_WEBHOOKS=true (development only)",
            extra={"ip": request.client.host if request.client else "unknown"},
        )

    # 4. Envelope validation (SPEC §8.4)
    if body is None:
        logger.warning("Rejected webhook: invalid envelope schema (empty or malformed JSON)")
        return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"ok": False})

    try:
        envelope = WebhookEnvelope(**body)
    except ValidationError as err:
        logger.warning("Rejected webhook: invalid envelope schema", extra={"issues": err.errors()})
        return JSONResponse(status_code=status.HTTP_400_BAD_REQUEST, content={"ok": False})

    # 5. Durable storage into sync_inbox (INV-3)
    if not pool:
        logger.error("Database pool not available for webhook ingestion")
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"ok": False})

    try:
        enqueue_result = await InboxRepository.enqueue_event(
            pool,
            InboxEventInput(
                event_id=envelope.id,
                event_type=envelope.type,
                entity_type=envelope.entity.type if envelope.entity else None,
                entity_id=envelope.entity.id if envelope.entity else None,
                event_timestamp=envelope.timestamp,
                payload=body,
            ),
        )

        if enqueue_result.is_duplicate:
            logger.info(
                "Acknowledged duplicate webhook event delivery", extra={"eventId": envelope.id}
            )
            return JSONResponse(
                status_code=status.HTTP_200_OK, content={"ok": True, "duplicate": True}
            )

        logger.info(
            "Durable webhook event stored in sync_inbox",
            extra={
                "eventId": envelope.id,
                "eventType": envelope.type,
                "entityId": envelope.entity.id if envelope.entity else None,
            },
        )
        return JSONResponse(status_code=status.HTTP_200_OK, content={"ok": True})
    except Exception as db_err:
        logger.error(
            "Failed to durably store webhook event in database",
            extra={"err": str(db_err), "eventId": envelope.id},
        )
        return JSONResponse(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, content={"ok": False})
