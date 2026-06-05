import express from "express";
import dotenv from "dotenv";
import { structure } from "./lib/structure.js";
import { enrich, DEFAULT_BUILDING } from "./lib/enrich.js";
import { recommend } from "./lib/workflow.js";
import { listSignals, addSignal, setClosure } from "./lib/store.js";

dotenv.config();

const {
  CA_API_URL = "https://327cherry.stg.criticalasset.com/api",
  CA_CLIENT_ID,
  CA_CLIENT_SECRET,
  CA_SCOPES = "workorders.read assets.read locations.read",
  PORT = 3000,
} = process.env;

const app = express();
app.use(express.json());
app.use(express.static("public"));

// --- Token cache (server-side only) -----------------------------------------
let tokenCache = { accessToken: null, refreshToken: null, expiresAt: 0 };

async function gqlFetch(query, variables, { bearer } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const res = await fetch(CA_API_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 300)}`);
  }
  return { status: res.status, json };
}

const TOKEN_MUTATION = `
mutation ApplicationToken($input: ApplicationClientCredentialsInput!) {
  applicationClientCredentialsToken(input: $input) {
    accessToken
    refreshToken
    tokenType
    expiresIn
    scope
  }
}`;

const REFRESH_MUTATION = `
mutation RefreshApplicationToken($refreshToken: String!) {
  applicationRefreshToken(refreshToken: $refreshToken) {
    accessToken
    refreshToken
    tokenType
    expiresIn
    scope
  }
}`;

async function exchangeToken() {
  if (!CA_CLIENT_ID || !CA_CLIENT_SECRET) {
    throw new Error(
      "Missing CA_CLIENT_ID / CA_CLIENT_SECRET. Copy .env.example to .env and paste your credentials."
    );
  }
  const { json } = await gqlFetch(TOKEN_MUTATION, {
    input: {
      clientId: CA_CLIENT_ID,
      clientSecret: CA_CLIENT_SECRET,
      scope: CA_SCOPES,
    },
  });
  if (json.errors) {
    throw new Error(`Token exchange failed: ${JSON.stringify(json.errors)}`);
  }
  const t = json.data?.applicationClientCredentialsToken;
  if (!t?.accessToken) {
    throw new Error(`Token exchange returned no accessToken: ${JSON.stringify(json)}`);
  }
  cacheToken(t);
  return tokenCache.accessToken;
}

function cacheToken(t) {
  tokenCache = {
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? tokenCache.refreshToken,
    // refresh ~60s before stated expiry
    expiresAt: Date.now() + Math.max(0, (t.expiresIn ?? 3600) - 60) * 1000,
  };
}

async function getToken() {
  if (tokenCache.accessToken && Date.now() < tokenCache.expiresAt) {
    return tokenCache.accessToken;
  }
  if (tokenCache.refreshToken) {
    try {
      const { json } = await gqlFetch(REFRESH_MUTATION, {
        refreshToken: tokenCache.refreshToken,
      });
      const t = json.data?.applicationRefreshToken;
      if (t?.accessToken) {
        cacheToken(t);
        return tokenCache.accessToken;
      }
    } catch {
      /* fall through to full re-auth */
    }
  }
  return exchangeToken();
}

// Run an authenticated query, transparently re-authing once on a 401.
async function authedQuery(query, variables) {
  let token = await getToken();
  let { status, json } = await gqlFetch(query, variables, { bearer: token });
  const unauthorized =
    status === 401 ||
    json.errors?.some((e) =>
      /unauth|expired|401/i.test(e.message || e.extensions?.code || "")
    );
  if (unauthorized) {
    tokenCache = { accessToken: null, refreshToken: null, expiresAt: 0 };
    token = await getToken();
    ({ status, json } = await gqlFetch(query, variables, { bearer: token }));
  }
  return { status, json };
}

// --- Work orders -------------------------------------------------------------
// Query matches the live CriticalAsset schema (verified via introspection):
// workOrders(limit) returns [WorkOrder]; status lives on workOrderStage.name,
// priority on executionPriority, due date on endDate, and assets/assignees are
// join tables (workOrderAssets / workOrderAssignments).
const WORKORDERS_QUERY = `
query FetchWorkOrders($limit: Int!) {
  workOrders(limit: $limit) {
    totalCount
    nodes {
      id
      title
      description
      severity
      executionPriority
      workOrderType
      workOrderServiceCategory
      startDate
      endDate
      createdAt
      workOrderStage { name color_code }
      location { id locationName address city state }
      workOrderAssets { asset { id name status } }
      workOrderAssignments { assignmentType userIds }
    }
  }
}`;

// Normalize the live schema into the flat shape the UI understands.
function normalize(list) {
  if (!Array.isArray(list)) return [];
  return list.map((w) => {
    const firstAsset = w.workOrderAssets?.find((a) => a.asset)?.asset || null;
    const assetCount = (w.workOrderAssets || []).filter((a) => a.asset).length;
    const assigneeCount = (w.workOrderAssignments || [])
      .flatMap((a) => a.userIds || [])
      .filter(Boolean).length;
    return {
      id: w.id,
      title: w.title,
      description: w.description ?? "",
      status: w.workOrderStage?.name ?? "Unknown",
      statusColor: w.workOrderStage?.color_code ?? null,
      priority: w.executionPriority ?? "UNKNOWN",
      severity: w.severity ?? null,
      type: w.workOrderType ?? null,
      serviceCategory: w.workOrderServiceCategory ?? null,
      createdAt: w.createdAt ?? null,
      startDate: w.startDate ?? null,
      dueDate: w.endDate ?? null,
      asset: firstAsset
        ? {
            id: firstAsset.id,
            name: assetCount > 1 ? `${firstAsset.name} (+${assetCount - 1})` : firstAsset.name,
            status: firstAsset.status,
          }
        : null,
      location: w.location
        ? {
            id: w.location.id,
            locationName: w.location.locationName,
            address: [w.location.address, w.location.city, w.location.state]
              .filter(Boolean)
              .join(", "),
          }
        : null,
      assignee: assigneeCount
        ? { name: `${assigneeCount} assigned` }
        : null,
    };
  });
}

app.get("/api/workorders", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  try {
    const { json } = await authedQuery(WORKORDERS_QUERY, { limit });
    if (json.errors) {
      return res.status(502).json({ error: "GraphQL errors", details: json.errors });
    }
    res.json({
      total: json.data?.workOrders?.totalCount ?? null,
      workOrders: normalize(json.data?.workOrders?.nodes),
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Raw passthrough for experimentation from the browser (still server-authed).
app.post("/api/graphql", async (req, res) => {
  try {
    const { query, variables } = req.body || {};
    if (!query) return res.status(400).json({ error: "Missing 'query'." });
    const { status, json } = await authedQuery(query, variables);
    res.status(status).json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Schema introspection helper for debugging the live API shape.
app.get("/api/schema", async (_req, res) => {
  const query = `
  query Introspect {
    __schema {
      queryType { fields { name args { name } type { name kind ofType { name } } } }
    }
  }`;
  try {
    const { json } = await authedQuery(query, {});
    res.json(json);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Challenge 02: Field Truth -> AI structuring -> enrichment -> workflow ----

// Run the full Copilot pipeline on a free-text observation (or a WO's description).
app.post("/api/copilot", async (req, res) => {
  try {
    const { text, workOrderId, location } = req.body || {};
    if (!text || !text.trim()) return res.status(400).json({ error: "Missing 'text'." });
    const structured = await structure(text, { location, workOrderId });
    const enrichment = await enrich(structured, DEFAULT_BUILDING);
    const workflow = recommend(structured, enrichment);
    res.json({ input: text, workOrderId: workOrderId ?? null, structured, enrichment, workflow });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Write-back: create a real CriticalAsset work order from a field report ---
const SERVICE_CATEGORY = {
  hvac: "hvac", plumbing: "plumbing", electrical: "electrical",
  firelife: "fire_and_life_safety", elevator: "general",
  airquality: "hvac", structural: "structural", general: "general",
};
const SEVERITY_ENUM = { Critical: "critical", High: "high", Medium: "medium", Low: "low" };

let cachedLocationId = null;
async function getLocationId() {
  if (cachedLocationId) return cachedLocationId;
  const { json } = await authedQuery("query { locations { id locationName } }", {});
  cachedLocationId = json.data?.locations?.[0]?.id || null;
  return cachedLocationId;
}

const CREATE_WORKORDER = `
mutation CreateWO($input: CreateWorkOrderInput!) {
  createWorkOrder(input: $input) { id title }
}`;

async function createWorkOrderFromReport({ structured, workflow, text }) {
  const locationId = await getLocationId();
  if (!locationId) throw new Error("No location available to attach the work order.");
  const severity = SEVERITY_ENUM[structured.severity] || "medium";
  const input = {
    title: `[Field Report] ${structured.issueType} — ${structured.location}`.slice(0, 120),
    description: workflow?.cleanedWorkOrder || text,
    severity,
    executionPriority: severity,
    locationId,
    workOrderType: severity === "critical" ? "emergency" : "corrective_maintenance",
    workOrderServiceCategory: SERVICE_CATEGORY[structured.categoryKey] || "general",
    workOrderAssignments: [],
    timeZone: "America/New_York",
    startDate: new Date().toISOString(),
  };
  const { json } = await authedQuery(CREATE_WORKORDER, { input });
  if (json.errors) throw new Error(json.errors.map((e) => e.message).join("; "));
  return json.data?.createWorkOrder;
}

app.post("/api/workorders/create", async (req, res) => {
  try {
    const { structured, workflow, text } = req.body || {};
    if (!structured) return res.status(400).json({ error: "Missing 'structured'." });
    const wo = await createWorkOrderFromReport({ structured, workflow, text });
    res.json({ workOrder: wo });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Persisted field signals + closure feedback loop.
app.get("/api/signals", (req, res) => {
  res.json({ signals: listSignals(req.query.workOrderId) });
});

app.post("/api/signals", (req, res) => {
  const { workOrderId, text, structured, workflow } = req.body || {};
  if (!text) return res.status(400).json({ error: "Missing 'text'." });
  res.json({ signal: addSignal({ workOrderId: workOrderId ?? null, text, structured, workflow }) });
});

app.post("/api/signals/:id/closure", (req, res) => {
  const { status } = req.body || {};
  if (!["fixed", "still", "worse"].includes(status))
    return res.status(400).json({ error: "status must be fixed | still | worse" });
  const rec = setClosure(req.params.id, status);
  if (!rec) return res.status(404).json({ error: "Signal not found." });
  res.json({ signal: rec });
});

app.get("/api/health", async (_req, res) => {
  res.json({
    ok: true,
    apiUrl: CA_API_URL,
    hasClientId: Boolean(CA_CLIENT_ID),
    hasSecret: Boolean(CA_CLIENT_SECRET),
    tokenCached: Boolean(tokenCache.accessToken),
    aiEngine: process.env.OPENAI_API_KEY ? "openai" : "rule-based",
  });
});

app.listen(PORT, () => {
  console.log(`\n  327 Cherry Street ops dashboard → http://localhost:${PORT}`);
  console.log(`  CriticalAsset endpoint: ${CA_API_URL}`);
  if (!CA_CLIENT_ID || !CA_CLIENT_SECRET) {
    console.log("  ⚠  No credentials yet. Copy .env.example → .env and paste them.\n");
  } else {
    console.log("");
  }
});
