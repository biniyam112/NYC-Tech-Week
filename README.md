# 327 Cherry Street — Facility Operations Copilot
### Project Report · "The City / Hacks / The State" Hackathon (Team 13)

> A work-order operations dashboard that turns messy, real-world field reports into
> structured, compliance-aware work orders — enriched with live NYC public data and
> written back into the CriticalAsset system of record.

---

## 1. Executive Summary

We built an end-to-end **facility operations copilot** for 327 Cherry Street (a building
on Manhattan's Lower East Side). The system connects directly to the **CriticalAsset**
infrastructure-management platform and to **NYC Open Data**, and uses an AI structuring
layer to convert a one-sentence field observation (e.g. *"the boiler room still smells
like gas, worse after 11am"*) into:

- a clean, structured, severity-rated **work order** created in CriticalAsset,
- **live public-data context** (prior 311 calls, HPD/DOB violations at the address),
- a **recommended workflow** (who to assign, escalation triggers, compliance obligations),
- a **drafted agency complaint email**, a **printable report**, and
- a **neighborhood map** of the same problem reported nearby.

The result is deployed publicly on **Vercel** with **GitHub auto-deploy**.

---

## 2. Problem Statement

Critical infrastructure operators (utilities, agencies, large facilities) drown in
unstructured, low-quality field reports. Issues are:

- **Described inconsistently** — free text, jargon, ambiguous locations.
- **Disconnected from public record** — the same problem may already be a known 311
  pattern or an open HPD/DOB violation, but operators don't see that context.
- **Hard to route and close** — no clear severity, no escalation logic, and "false
  closures" (marking something fixed when it isn't) are common.

Our copilot addresses each of these: **structure → enrich → recommend → act → verify.**

---

## 3. What We Built

### Challenge 1 — Work Order Operations Dashboard
A live, Linear/Asana-inspired dashboard reading real work orders from CriticalAsset.

- **Board (Kanban), List, and Map** views with a segmented toggle.
- Metrics bar (Total / Open / In Progress / Overdue) and priority filters.
- Search across title, asset, location, and status.
- A detail drawer per work order with full metadata and the embedded Copilot.

### Challenge 2 — The Field-Report Copilot (AI pipeline)
The core innovation. One pipeline (`POST /api/copilot`) runs four stages:

1. **Structure** (`lib/structure.js`) — classifies the report into issue type, severity,
   urgency, recurrence, affected parties, evidence quality, and likely asset categories.
   Rule-based by default (works fully offline); optional OpenAI LLM upgrade.
2. **Enrich** (`lib/enrich.js`) — queries three live NYC Open Data sets and translates
   raw records into *operational meaning*, not just counts.
3. **Recommend** (`lib/workflow.js`) — produces assignment group, escalation decision +
   reasons, compliance implications, next actions, an evidence checklist, a
   student/occupant-facing status message, and a closure-verification question.
4. **Act** — creates a real work order back in CriticalAsset
   (`POST /api/workorders/create`) and persists the report as a "signal".

### Value-Add Features
- **Write-back to CriticalAsset** — reports become real work orders in the system of record.
- **Closure verification loop** — "Fixed / Still happening / Worse" feedback prevents
  false closures and auto-escalates worsening conditions.
- **Agency email composer** (`lib/agency.js`) — routes the issue to the correct NYC
  agency and drafts a formal complaint email; optional SMTP send, or open-in-mail-client / copy.
- **Printable field report** — clean, print-optimized one-pager for the record.
- **Neighborhood operations Map tab** — Leaflet map of facility-relevant 311 reports
  around the building, color-coded by category with a filterable legend and adjustable
  radius (500 m / 1 km / 2 km) and time window (6 mo / 12 mo / 3 yr).

---

## 4. System Architecture

```
Browser (vanilla HTML/CSS/JS, Leaflet)
        │  fetch /api/*
        ▼
Express server (server.js)  ──►  CriticalAsset GraphQL API (OAuth2 client-credentials)
        │                         (work orders read/write, locations, assets)
        ├──►  NYC Open Data / Socrata (311, HPD, DOB)
        ├──►  lib/structure.js   (AI structuring: rules + optional OpenAI)
        ├──►  lib/enrich.js      (public-data enrichment + geo queries)
        ├──►  lib/workflow.js    (assignment / escalation / compliance)
        ├──►  lib/agency.js      (agency routing + email drafting)
        └──►  lib/store.js       (signals + outbox persistence)
```

- **Backend:** Node.js + Express (ESM). Server-side OAuth2 token cache; GraphQL
  passthrough + introspection helper.
- **Frontend:** Single-page app, no framework — vanilla HTML/CSS/JS, Leaflet for maps,
  Inter font, custom dark "ops console" theme.
- **Deployment:** Vercel serverless function (`api/index.js` wraps the Express app),
  static assets bundled, GitHub-connected auto-deploy.

---

## 5. Data Sources & Integrations

| Source | Dataset / Endpoint | Used for |
|---|---|---|
| **CriticalAsset** | GraphQL API (staging) | Work orders (read/write), locations, building coordinates |
| **NYC 311** | Socrata `erm2-nwe9` | Prior service requests at the address; neighborhood patterns; map points |
| **HPD Violations** | Socrata `wvxf-dwi5` | Open housing-maintenance violations at the address |
| **DOB Violations** | Socrata `3h2n-5cm9` | Structural / electrical / life-safety violation history |
| **OpenAI (optional)** | Chat Completions | Higher-quality structuring + email drafting when a key is set |

**Geospatial:** map markers use Socrata's `within_circle(location, …)` geospatial query;
the building's center comes from CriticalAsset's `coordinates` field (with a Lower East
Side fallback).

---

## 6. API Surface (Express endpoints)

| Endpoint | Purpose |
|---|---|
| `GET /api/workorders` | List normalized work orders from CriticalAsset |
| `POST /api/copilot` | Run the structure → enrich → recommend pipeline |
| `POST /api/workorders/create` | Create a work order in CriticalAsset from a report |
| `GET/POST /api/signals` | List / persist field signals |
| `POST /api/signals/:id/closure` | Record closure feedback (fixed/still/worse) |
| `POST /api/compose` | Draft the agency complaint email |
| `POST /api/send-email` | Send via SMTP (or log to outbox) |
| `GET /api/outbox` | List sent/logged emails |
| `POST /api/nearby` | Similar 311 reports near the building (issue-specific) |
| `POST /api/area-map` | Categorized facility 311 reports for the Map tab |
| `POST /api/graphql`, `GET /api/schema` | GraphQL passthrough + introspection |
| `GET /api/health` | Status (credentials present, token cached, AI engine) |

---

## 7. Technical Challenges & How We Solved Them

- **Undocumented GraphQL schema.** The live CriticalAsset schema differed from the docs
  (`WorkOrderConnection { nodes }`, `endDate` not `dueDate`, nested `workOrderAssets` /
  `workOrderAssignments`). We used **introspection** through our own passthrough endpoint
  to discover the real shape, then normalized it.
- **Backend resolver bug.** Querying nested `users` triggered a server-side error
  (`column u.phone does not exist`). We worked around it by requesting `userIds` instead.
- **Geo queries on text fields.** 311 latitude/longitude are stored as text, so range
  filters failed. We switched to Socrata's `within_circle(location, …)` geospatial function.
- **Socrata query timeouts.** Filtering with `upper(complaint_type)` forced a full table
  scan (>12 s). We matched the **exact complaint-type casing** to use the index and gave
  the heavy map query a longer timeout — bringing it to a reliable ~10 s.
- **Serverless adaptation for Vercel.** Replaced `app.listen` with an exported app +
  function entrypoint, redirected file writes to `/tmp`, bundled `public/` into the
  function, and raised `maxDuration` for the slow 311 query.
- **UI scroll bug.** Board columns were shrinking and clipping cards; fixed with proper
  flex (`flex: 1; min-height: 0`) so each column scrolls independently.

---

## 8. Deployment

- **Hosting:** Vercel (serverless). Static SPA served by Express; `/api/*` handled by the
  function.
- **CI/CD:** Connected to GitHub (`biniyam112/NYC-Tech-Week`); every push to `master`
  auto-deploys to production, branches get preview deploys.
- **Secrets:** CriticalAsset credentials live only in environment variables (never
  committed); `.env` is gitignored.

---

## 9. Impact / Why It Matters

- **Faster, cleaner intake** — anyone can report in plain language; the AI does the
  structuring and routing.
- **Context-aware decisions** — operators see the public-record history (recurring
  patterns, open violations) *before* they act, raising the quality of triage.
- **Compliance-first** — habitability/life-safety obligations are surfaced automatically.
- **Closure integrity** — the verification loop prevents premature "fixed" status.
- **System-of-record fidelity** — every report becomes a real CriticalAsset work order.

---

## 10. Future Work

- Durable storage (Vercel KV / Postgres) for signals + outbox across cold starts.
- Photo upload + vision model for evidence capture.
- Multi-building / portfolio rollout (the building is currently a single configured asset).
- Real agency-email integration with verified addresses and delivery receipts.
- Trend analytics: recurring-issue detection and predictive maintenance.