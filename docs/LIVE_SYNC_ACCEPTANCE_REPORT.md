# Live End-to-End Notion → PostgreSQL Sync Acceptance Report

**Test Date & Time:** 2026-10-24 15:25:00 IST (2026-10-24 09:55:00 UTC)  
**Repository & Working Tree:** `D:\Notion`  
**Audited Commit:** `c9ca6c6` (`docs: update AGENTS.md with comprehensive project instructions, command references, and architectural invariants`)  
**Git Working Tree Status:** Clean (`main`, up to date with `origin/main`)  

---

## 1. Executive Summary

A controlled live acceptance test was initiated to verify end-to-end synchronization between the user's Notion Tasks data source and the target Neon PostgreSQL database using the real connected **Notion MCP** and **Neon MCP**.

In accordance with **Non-Negotiable Safety Rule 5** ("*If either required MCP is unavailable or access is insufficient, stop before creating the test task and report the exact blocker*") and **Phase 3 requirements** ("*If any required table is missing or the selected database is ambiguous, stop before writing a test task and report the problem. Do not apply an unreviewed migration to a live database*"), **live test task creation was halted prior to Phase 6**.

### Primary Blockers Identified:
1. **Neon MCP Server Authentication Failure (`BLOCKED`):**  
   The configured Neon MCP server (`https://mcp.neon.tech/mcp`) fails during initialization with HTTP 401 Unauthorized (`server name Neon failed to load: calling "initialize": sending "initialize": Unauthorized`). No `NEON_API_KEY` is present in the environment or configuration (`C:\Users\Dawood\.gemini\config\mcp_config.json`), and the Neon CLI has no stored session (`neon me` reports `profile "DEFAULT" has no stored credential`). Per safety rules, application-level direct database queries cannot substitute for Neon MCP verification.
2. **Missing PostgreSQL Synchronization Schema (`BLOCKED`):**  
   Read-only database catalog inspection revealed that the `notion_sync` schema does not exist in the target PostgreSQL database (`neondb`). The database currently contains only `neon_auth.*` tables. No migrations have ever been applied to the live database. Applying migrations without prior review is prohibited by safety rules.
3. **Unconfigured Application Environment (`BLOCKED`):**  
   The `.env` file in `D:\Notion` contains placeholder values for critical synchronization settings:
   - `NOTION_DATABASE_ID=your_notion_database_uuid_here` (unconfigured)
   - `NOTION_DATA_SOURCE_ID=` (blank)
   - `NOTION_WEBHOOK_VERIFICATION_TOKEN=your_webhook_verification_token_here` (unconfigured)
   - `DIRECT_DATABASE_URL=postgresql://user:password@direct-host/dbname?sslmode=require` (invalid host `direct-host` which breaks migration status commands with `ENOTFOUND direct-host`)
4. **Notion Resource Discrepancies (`RESOLVED & DOCUMENTED`):**  
   The requested dashboard URL / ID (`4009d0b1018881a39271d10745313b18`) returned HTTP 404 (not shared with integration). Using Notion MCP's `API-post-search`, the actual accessible dashboard was discovered at page ID `4009d0b1-0188-8126-8d1c-c47cad33a78f` (`My Tasks`) with underlying data source `4009d0b1-0188-8139-901a-000b7b5d23a0` (`Tasks`). The schema differs from the prompt specification (e.g., status is `To do` / `In progress` / `Done` rather than `Not started`; `Notes` and `Goal Period` properties do not exist).

---

## 2. Target Resources Identity

| Resource | Value | Notes / Resolution |
|---|---|---|
| **Notion Integration** | `Anitgravity` (ID: `3739d0b1-0188-8152-97c6-002766b91294`) | Authorized integration for Notion MCP |
| **Notion Dashboard (Provided)** | `https://app.notion.com/p/My-Tasks-4009d0b1018881a39271d10745313b18` | Returned HTTP 404 / Object not shared |
| **Notion Dashboard (Actual Verified)** | `https://app.notion.com/p/My-Tasks-4009d0b1018881268d1cc47cad33a78f` | Page ID: `4009d0b1-0188-8126-8d1c-c47cad33a78f` (Verified via Notion MCP) |
| **Notion Parent Database ID** | `4009d0b1-0188-81b1-917b-e186d1d7ba8b` | Database containing the Tasks data source |
| **Notion Data-Source ID (Provided)** | `9af88461-2b5a-454e-8db0-ce5270e8b50d` | Not found in search |
| **Notion Data-Source ID (Actual Verified)** | `4009d0b1-0188-8139-901a-000b7b5d23a0` | Title: `Tasks` (Verified via `API-retrieve-a-data-source`) |
| **Neon Organization ID** | `org-rapid-band-37836484` | Recorded in `D:\Notion\.neon` |
| **Neon Project ID** | `soft-sound-78266230` | Recorded in `D:\Notion\.neon` |
| **Neon Branch** | `production` | Recorded in `D:\Notion\.neon` |
| **Neon Database Host** | `ep-morning-pond-b3ppvbmz-pooler.c-4.ap-southeast-1.aws.neon.tech` | Pooled endpoint from `DATABASE_URL` |
| **Target Database Name** | `neondb` | Verified reachable via pooled connection |
| **Target Schema** | `notion_sync` | **DOES NOT EXIST** on `neondb` (tables present: only `neon_auth.*`) |

---

## 3. MCP Connectivity and Tool Discovery (Phase 1)

### Notion MCP
- **Status:** **OPERATIONAL** (`PASS`)
- **Transport / Server:** `@notionhq/notion-mcp-server`
- **Authentication:** Valid Notion internal integration token configured in `mcp_config.json`.
- **Tools Discovered:**
  - `API-retrieve-a-page`: Fetches page metadata and properties by `page_id`.
  - `API-post-search`: Searches workspaces for accessible pages and data sources.
  - `API-retrieve-a-data-source`: Retrieves schema, property metadata, and parent info for a data source.
  - `API-query-data-source`: Queries pages within a data source with filters, sorting, and pagination.
  - `API-post-page`: Creates new pages in a data source / database.
  - `API-patch-page`: Updates page properties and archive state.
  - `API-retrieve-page-markdown` / `API-update-page-markdown`: Block content access.
- **Verification Performed:**
  - `API-post-search` called successfully: identified shared workspace pages and data sources.
  - `API-retrieve-a-data-source` called successfully with ID `4009d0b1-0188-8139-901a-000b7b5d23a0`: retrieved full schema.
  - `API-query-data-source` called successfully: queried existing records safely.

### Neon MCP
- **Status:** **BLOCKED** (`BLOCKED`)
- **Transport / Server:** Remote endpoint `https://mcp.neon.tech/mcp`
- **Error Encountered:** `server name Neon failed to load: calling "initialize": sending "initialize": Unauthorized`
- **Root Cause:**
  - The Neon remote MCP requires an `Authorization: Bearer <token>` header or `NEON_API_KEY`.
  - In `C:\Users\Dawood\.gemini\config\mcp_config.json`, the entry is:
    ```json
    "Neon": {
      "serverUrl": "https://mcp.neon.tech/mcp"
    }
    ```
    No headers or API keys are specified.
  - No `NEON_API_KEY` is present in system environment variables or `.env`.
  - Neon CLI (`neon me`) reports `Not signed in: profile "DEFAULT" has no stored credential`.
- **Safety Enforcement:** Per Rule 5, the test stopped before modifying or creating tasks, and direct database queries were not misrepresented as Neon MCP calls.

---

## 4. Notion Data Source Inspection (Phase 2)

Inspection of the verified Tasks data source (`4009d0b1-0188-8139-901a-000b7b5d23a0`) revealed the following property schema:

| Property Name | Property Type | Actual Options / Configuration | Notes vs Task Description |
|---|---|---|---|
| **Task** | `title` | Text / rich_text | Matches expected |
| **Status** | `status` | `To do` (default), `In progress`, `Done` | **Discrepancy:** Prompt expected `Not started`, actual is `To do` |
| **List** | `select` | `📥 Tasks`, `💼 Work`, `👤 Personal`, `📚 Learning`, `🏗️ Projects` | **Discrepancy:** Options carry emoji prefixes |
| **Priority** | `select` | `🔴 High`, `🟡 Medium`, `🔵 Low` | **Discrepancy:** Options carry emoji prefixes |
| **Important** | `checkbox` | Boolean | Matches expected |
| **In My Day** | `checkbox` | Boolean | Matches expected |
| **Due Date** | `date` | ISO Date / Date-time | Matches expected |
| **Reminder** | `date` | ISO Date / Date-time | Matches expected |
| **Repeat** | `select` | `None`, `Daily`, `Weekdays`, `Weekly`, `Monthly`, `Yearly` | Matches expected |
| **Archived** | `checkbox` | Boolean (custom property) | Matches expected |
| **Completed At** | `date` | ISO Date / Date-time | Additional property present in Notion |
| **Created** | `created_time` | Read-only timestamp | Matches expected |
| **Tags** | `multi_select` | Array of tags | Matches expected |
| **Sub-tasks** | `relation` | Dual property relation to self | Matches expected |
| **Parent task** | `relation` | Dual property relation to self | Matches expected |
| **Notes** | *Missing* | *Property does not exist* | **Discrepancy:** Prompt assumed `Notes` property exists |
| **Goal Period** | *Missing* | *Property does not exist* | **Discrepancy:** Prompt assumed `Goal Period` property exists |

---

## 5. Target Neon Database Inspection (Phase 3)

Direct read-only catalog queries to `neondb` (via `pg.Client` using `DATABASE_URL` with SSL verification) established:

```sql
SELECT table_schema, table_name 
FROM information_schema.tables 
WHERE table_schema NOT IN ('pg_catalog', 'information_schema');
```
**Result:**
- `neon_auth.account`
- `neon_auth.invitation`
- `neon_auth.jwks`
- `neon_auth.member`
- `neon_auth.organization`
- `neon_auth.project_config`
- `neon_auth.session`
- `neon_auth.user`
- `neon_auth.verification`

### Findings:
1. **Schema `notion_sync` is absent:** Neither `notion_tasks`, `sync_inbox`, nor `sync_runs` exist.
2. **Migrations not applied:** `migrations/0001_init.sql` has not been executed on `neondb`.
3. **Migration CLI blocker:** `npm run db:migrate -- status` fails with `getaddrinfo ENOTFOUND direct-host` because `.env` sets `DIRECT_DATABASE_URL=postgresql://user:password@direct-host/dbname?sslmode=require` as an unedited placeholder.
4. Per Safety Rules 7 & 9, migrations were **not** applied to the live database during this audit.

---

## 6. Audit of the Application's Real Sync Path (Phase 4)

| Area | Component | Implementation Status & Verification |
|---|---|---|
| **Webhook Receiver** | `src/server.ts`, `routes/webhooks.ts` | Handshake (`GET`), signature verification (`POST`), raw body buffering, durable inbox write (`db/inbox-repo.ts`). Fails closed (HTTP 503) if verification token missing in production. |
| **Signature Verification** | `routes/webhooks.ts` | HMAC-SHA256 over raw buffer. Development bypass `ALLOW_UNSIGNED_WEBHOOKS=true` is rejected in production. Currently unconfigured in `.env`. |
| **Worker Process** | `sync/worker.ts`, `scripts/worker.ts` | Standalone long-running daemon. Not currently running. Claims inbox rows via `FOR UPDATE SKIP LOCKED`. |
| **Authoritative Re-fetch** | `sync/worker.ts` | Implements INV-2: Re-fetches page from Notion SDK upon processing webhook change events. |
| **Data Source Resolution** | `sync/worker.ts`, `sync/notion-client.ts` | Implements BUG-001 fix: Resolves data source ID once and caches it to correctly calculate `is_in_source`. |
| **Normalization** | `sync/normalize.ts` | Maps properties flexibly using candidate aliases; parses timezone-aware dates; handles emojis; preserves unmapped fields in `raw_properties`. |
| **PostgreSQL Upsert** | `db/tasks-repo.ts` | Keyed on `notion_page_id`. Implements INV-4 stale-write guard (`EXCLUDED.notion_last_edited_time >= stored`). Implements BUG-004 fix: preserves `page_content_json` when incoming content is SQL `NULL`. |
| **Inbox Settlement** | `sync/worker.ts`, `db/pool.ts` | Implements INV-6: Atomic commit of task upsert and inbox settlement inside `withTransaction()`. |
| **Local Automated Quality Gates** | `npm run typecheck`, `npm run lint`, `npm test` | **All 128 tests pass** (78 unit, 41 embedded Postgres 18 integration, 9 e2e acceptance). |

---

## 7. Pre-Test Safety Baseline & Check (Phase 5)

- **Generated Unique Marker:** `SYNC-E2E-TEST-20261024-095500-A7F2`
- **Proposed Task Title:** `SYNC-E2E-TEST-20261024-095500-A7F2`
- **Pre-Test Search in Notion:** Queried data source `4009d0b1-0188-8139-901a-000b7b5d23a0` via Notion MCP. Confirmed **zero** tasks exist with marker `SYNC-E2E-TEST-20261024-095500-A7F2`.
- **Pre-Test Search in PostgreSQL:** Unable to query `notion_sync.notion_tasks` because the table and schema do not exist.
- **Go / No-Go Decision:** **NO-GO**. Safety rules require halting before Phase 6 when MCP connectivity or database prerequisites fail.

---

## 8. Detailed Acceptance Verification Matrix

| Check ID | Phase / Scenario | Status | Independent Verification Evidence / Blocker |
|---|---|---|---|
| **CHK-01** | Notion MCP Connectivity | **PASS** | Notion MCP tools discovered; search, retrieval, and schema introspection verified against live Notion API. |
| **CHK-02** | Neon MCP Connectivity | **BLOCKED** | Neon MCP initialization returns HTTP 401 Unauthorized due to missing Neon API key. |
| **CHK-03** | Notion Dashboard & Data Source Resolution | **PASS** | Resolved discrepancy: actual dashboard is `My Tasks` (`4009d0b1-0188-8126-8d1c-c47cad33a78f`) and Tasks data source is `4009d0b1-0188-8139-901a-000b7b5d23a0`. |
| **CHK-04** | Target PostgreSQL Database Identification | **PASS** | Identified `neondb` on project `soft-sound-78266230` via `.neon` and `DATABASE_URL`. |
| **CHK-05** | PostgreSQL Application Schema Verification | **BLOCKED** | Schema `notion_sync` and tables `notion_tasks`, `sync_inbox`, `sync_runs` do not exist on `neondb`. |
| **CHK-06** | Task Creation via Notion MCP | **BLOCKED** | Halted prior to execution to comply with Safety Rules 5 & 10. |
| **CHK-07** | Pipeline Event Processing to PostgreSQL | **BLOCKED** | Webhook endpoint not publicly reachable, verification token placeholder, worker offline, and DB schema missing. |
| **CHK-08** | Task Property Update Synchronization | **NOT TESTED** | Dependent on CHK-06 and CHK-07. |
| **CHK-09** | Task Completion Synchronization | **NOT TESTED** | Dependent on CHK-06 and CHK-07. |
| **CHK-10** | Task Archival Synchronization | **NOT TESTED** | Dependent on CHK-06 and CHK-07. |
| **CHK-11** | Stale Write / Idempotency Guards | **PASS (Local)** | Formally verified in automated integration test suite (`tests/integration/repositories.test.ts`, 41/41 passing). |
| **CHK-12** | Duplicate Row Prevention | **PASS (Local)** | Primary key on `notion_page_id` and unique `event_id` verified in automated test suite. |

---

## 9. Errors, Discrepancies, and Observations

1. **Notion URL / ID Mismatch:**
   - Provided URL: `https://app.notion.com/p/My-Tasks-4009d0b1018881a39271d10745313b18`
   - Actual shared URL: `https://app.notion.com/p/My-Tasks-4009d0b1018881268d1cc47cad33a78f`
   - Provided Data Source ID: `9af88461-2b5a-454e-8db0-ce5270e8b50d`
   - Actual Data Source ID: `4009d0b1-0188-8139-901a-000b7b5d23a0`
2. **Property Schema Differences:**
   - `Status`: Notion values are `To do`, `In progress`, `Done`. (The prompt suggested `Not started`).
   - `List` and `Priority`: Option values in Notion are prefixed with emoji icons (`📥 Tasks`, `🔴 High`, etc.).
   - `Notes` and `Goal Period`: Do not exist as database properties. Note content would need to reside in Notion page markdown blocks.
3. **Neon MCP Server Authentication:**
   - Remote MCP `https://mcp.neon.tech/mcp` rejected connection with HTTP 401 Unauthorized.
4. **Invalid `DIRECT_DATABASE_URL` in `.env`:**
   - Default `.env` had `postgresql://user:password@direct-host/dbname?sslmode=require`. Any command relying on direct connections (such as `db:migrate`) fails hostname resolution for `direct-host`.

---

## 10. Code Changes & Repository State

- **Files Modified:** None. Working tree remains clean on branch `main`.
- **Scratch Files Generated:** Temporary read-only inspection script created in artifact scratch directory (`brain/.../scratch/inspect_db.js`).

---

## 11. Remediation Plan to Achieve Full Live Verification

To transition all `BLOCKED` checks to `PASS` in a live end-to-end test, execute the following prerequisites:

1. **Configure Neon MCP Server Authentication:**
   - Obtain a Neon API Key from the Neon Console.
   - Update `C:\Users\Dawood\.gemini\config\mcp_config.json`:
     ```json
     "Neon": {
       "serverUrl": "https://mcp.neon.tech/mcp",
       "headers": {
         "Authorization": "Bearer <NEON_API_KEY>"
       }
     }
     ```
   - Alternatively, sign in via the Neon CLI: `neon login`.
2. **Configure Database URLs & Run Migrations on Neon:**
   - In `.env`, set `DIRECT_DATABASE_URL` to the direct (non-pooled) connection string for project `soft-sound-78266230`.
   - Run `npm run db:migrate` to create the `notion_sync` schema and tables (`notion_tasks`, `sync_inbox`, `sync_runs`).
3. **Configure Notion IDs in `.env`:**
   - Set `NOTION_DATABASE_ID=4009d0b1-0188-81b1-917b-e186d1d7ba8b`
   - Set `NOTION_DATA_SOURCE_ID=4009d0b1-0188-8139-901a-000b7b5d23a0`
4. **Configure Public Webhook Tunnel & Subscription:**
   - Set up a public tunnel (e.g., ngrok or Cloudflare Tunnel) to port 3000.
   - Register the webhook in Notion Developer Portal pointing to `https://<tunnel-domain>/webhooks/notion`.
   - Update `NOTION_WEBHOOK_VERIFICATION_TOKEN` in `.env`.
5. **Start HTTP Receiver and Worker:**
   - Run `npm run dev` (or `npm start`) in one terminal.
   - Run `npm run worker` in a second terminal.
6. **Re-run Live Acceptance Test:**
   - Execute the Phase 6–9 sequence using Notion MCP and Neon MCP.
