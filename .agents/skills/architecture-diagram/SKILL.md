---
name: architecture-diagram
description: Generate, inspect, edit, and open system architecture, data-flow, and sequence diagrams in draw.io using the official draw.io MCP server (@drawio/mcp). Use whenever the user asks to create, analyze, convert, or update architecture diagrams, or invokes /analyze-architecture.
---

# Architecture Diagram Intelligence (draw.io MCP)

This skill guides the automated inspection of a codebase and the generation, editing, and visualization of professional software architecture diagrams in **draw.io** via the official `@drawio/mcp` Model Context Protocol integration.

---

## 1. Core Principles & Governance

1. **Repository as Source of Truth**:
   - Inspect the codebase thoroughly before designing or generating any diagram.
   - Only diagram services, databases, caches, queues, and components that **actually exist** in the repository.
   - If a relationship or dependency is inferred or ambiguous, label it explicitly as `(Inferred / Optional)` rather than presenting it as factual.

2. **Prefer draw.io MCP Tools**:
   - Use `open_drawio_mermaid` for rapid structural flowcharts, C4 container models, and sequence diagrams.
   - Use `open_drawio_xml` for precise multi-layer layout, custom styling, or native draw.io stencil libraries.
   - Use `list_pages`, `get_page`, and `set_page` when inspecting or modifying existing `.drawio` project files.
   - Use `search_shapes` when industry-specific cloud stencils (AWS, Azure, GCP, Kubernetes, Cisco) or branded icons are requested.

3. **Multi-Tier Separation & Visual Clarity**:
   - Group related components into logical subgraphs (Client Tier, Edge/Ingestion Tier, Backend API Services, Background Workers, Persistence & Cache, Third-Party SaaS).
   - Use directional arrows with protocol labels (e.g., `HTTPS / TLS`, `REST API / JSON`, `SQL / pgvector`, `Redis Cache`, `Async Celery Job`, `Webhook`).
   - Maintain high contrast and consistent color coding across architectural tiers.
   - Avoid intersecting connector lines where practical.

---

## 2. Reusable Commands & Workflows

### Command: `/analyze-architecture`
When the user asks to analyze the architecture or runs `/analyze-architecture`:

1. **Phase 1 — Deep Repository Audit**:
   - Identify frontend frameworks (`apps/frontend`, Next.js, Vite, React, Vue).
   - Identify backend application engines (`apps/backend`, Django, FastAPI, Express, NestJS).
   - Identify data persistence & vector engines (`PostgreSQL`, `Neon`, `pgvector`, `Prisma`, `TypeORM`).
   - Identify caching & message brokers (`Redis`, `Kafka`, `RabbitMQ`, `Celery`).
   - Identify authentication & identity providers (`Clerk`, `Auth0`, `Firebase`, `NextAuth`).
   - Identify object storage & CDN (`Cloudflare R2`, `AWS S3`, `Google Cloud Storage`).
   - Identify AI/LLM pipelines (OpenAI, Anthropic, Gemini, LangChain, RAG embeddings).
   - Identify CI/CD & cloud deployment infrastructure (`Vercel`, `Render`, `Docker`, `GitHub Actions`).

2. **Phase 2 — Diagram Generation**:
   - Construct a clean, structured Mermaid or mxGraphModel XML architecture definition.
   - Call `open_drawio_mermaid` or `open_drawio_xml` via MCP to generate the live editable draw.io diagram URL and open it in the user's browser.

3. **Phase 3 — Documentation Sync**:
   - Save or update the architecture diagram specification in `docs/architecture/`.
   - Provide the user with the direct live editable draw.io URL and component breakdown summary.

### Command: `/architecture-impact`
When the user changes code and wants to determine which architecture diagrams are affected, invoke the **`architecture-impact`** workflow to perform incremental impact analysis, detect architecture drift, selectively update affected `.drawio` files, and generate `docs/architecture/ARCHITECTURE_IMPACT.md`.

---

## 3. Supported Diagram Types

| Diagram Type | Best Suited Tool | Description |
| :--- | :--- | :--- |
| **System Container Architecture** | `open_drawio_mermaid` | High-level topology showing tiers, protocols, databases, and external SaaS services. |
| **Data-Flow / Transaction Pipeline** | `open_drawio_mermaid` | Sequence or flowchart of payment checkout, auth sync, or outbox relay. |
| **RAG / AI Pipeline** | `open_drawio_mermaid` | Embeddings generation, vector indexing, similarity search, and LLM inference. |
| **Multi-Page draw.io Documents** | `list_pages`, `set_page` | Reading and updating multi-page `.drawio` files directly in the filesystem. |
| **Cloud Topology (AWS/GCP/Azure)** | `search_shapes` + `open_drawio_xml` | Native cloud iconography and stencil layouts. |
