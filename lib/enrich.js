// NYC public-data enrichment.
// Joins a structured issue to live NYC Open Data (Socrata) and translates the
// raw records into operational meaning — never just a count or a link dump.

const SOCRATA = "https://data.cityofnewyork.us/resource";
const DATASETS = {
  threeoneone: "erm2-nwe9", // 311 Service Requests
  hpd: "wvxf-dwi5", // HPD Housing Maintenance Code Violations
  dob: "3h2n-5cm9", // DOB Violations
};

// Default building for Team 13. (327 Cherry Street, Lower East Side, Manhattan.)
export const DEFAULT_BUILDING = {
  house: "327",
  street: "CHERRY STREET",
  borough: "MANHATTAN",
  boroCode: "1",
  zip: "10002",
};

function headers() {
  const h = { Accept: "application/json" };
  if (process.env.NYC_APP_TOKEN) h["X-App-Token"] = process.env.NYC_APP_TOKEN;
  return h;
}

async function soql(dataset, params) {
  const url = `${SOCRATA}/${dataset}.json?${new URLSearchParams(params)}`;
  const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(12000) });
  if (!res.ok) throw new Error(`Socrata ${dataset} ${res.status}`);
  return res.json();
}

function sqlList(values) {
  return values.map((v) => `'${String(v).replace(/'/g, "''")}'`).join(",");
}

// ---- 311 ---------------------------------------------------------------------
async function enrich311(structured, building) {
  const types = structured.nyc311Types?.length ? structured.nyc311Types : ["GENERAL"];
  const out = { source: "NYC 311 Service Requests", dataset: DATASETS.threeoneone, items: [] };

  // Building-specific first (strongest signal).
  try {
    const bldg = await soql(DATASETS.threeoneone, {
      $select: "created_date,complaint_type,descriptor,status,incident_address",
      $where: `incident_address like '${building.house} ${building.street.split(" ")[0]}%' AND borough='${building.borough}'`,
      $order: "created_date DESC",
      $limit: "20",
    });
    out.buildingMatches = bldg.length;
    out.items = bldg.slice(0, 5).map((r) => ({
      date: r.created_date?.slice(0, 10),
      type: r.complaint_type,
      detail: r.descriptor,
      status: r.status,
    }));
  } catch (e) {
    out.buildingError = e.message;
  }

  // Neighborhood pattern for this issue category.
  try {
    const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
    const pattern = await soql(DATASETS.threeoneone, {
      $select: "complaint_type,count(*) as n",
      $where: `upper(complaint_type) in (${sqlList(types.map((t) => t.toUpperCase()))}) AND borough='${building.borough}' AND created_date > '${since}T00:00:00'`,
      $group: "complaint_type",
      $order: "n DESC",
      $limit: "10",
    });
    out.neighborhoodPattern = pattern.map((p) => ({ type: p.complaint_type, count: Number(p.n) }));
    out.neighborhoodTotal = pattern.reduce((s, p) => s + Number(p.n), 0);
  } catch (e) {
    out.patternError = e.message;
  }

  out.operationalMeaning = build311Meaning(out, structured, building);
  return out;
}

function build311Meaning(out, structured, building) {
  const bits = [];
  if (out.buildingMatches > 0) {
    bits.push(
      `This building has ${out.buildingMatches} prior 311 service request(s) on record. Treat this as a likely recurring condition and link the new report to that history before closure.`
    );
  } else if (out.buildingMatches === 0) {
    bits.push(`No prior 311 requests found at ${building.house} ${building.street} — this may be the first reported instance, so capturing clean field evidence now is high-value.`);
  }
  if (out.neighborhoodTotal > 0) {
    bits.push(
      `${out.neighborhoodTotal} comparable "${structured.category}" complaints were filed across ${building.borough} in the last 12 months — this is a known, system-wide pattern, which supports prioritizing and standardizing the response.`
    );
  }
  return bits.join(" ") || "No 311 signal available for this category.";
}

// ---- HPD ---------------------------------------------------------------------
async function enrichHPD(building) {
  const out = { source: "HPD Housing Violations", dataset: DATASETS.hpd, items: [] };
  try {
    const street = building.street.replace(/\s+(STREET|ST)$/i, "");
    const rows = await soql(DATASETS.hpd, {
      $select: "novdescription,class,currentstatus,inspectiondate",
      $where: `housenumber='${building.house}' AND upper(streetname) like '${street.toUpperCase()}%' AND boroid='${building.boroCode}'`,
      $order: "inspectiondate DESC",
      $limit: "25",
    });
    out.total = rows.length;
    out.openCount = rows.filter((r) => /open|active/i.test(r.currentstatus || "")).length;
    out.items = rows.slice(0, 5).map((r) => ({
      class: r.class,
      status: r.currentstatus,
      date: r.inspectiondate?.slice(0, 10),
      detail: (r.novdescription || "").slice(0, 140),
    }));
    out.operationalMeaning =
      out.total > 0
        ? `${out.total} HPD violation record(s) exist for this address (${out.openCount} open). If this field report touches a habitability system (heat, water, sanitation), it should be cross-checked against these open violations — a new issue on an already-cited system raises compliance and escalation stakes.`
        : "No HPD violations on record for this address.";
  } catch (e) {
    out.error = e.message;
    out.operationalMeaning = "HPD lookup unavailable.";
  }
  return out;
}

// ---- DOB ---------------------------------------------------------------------
async function enrichDOB(building) {
  const out = { source: "DOB Violations", dataset: DATASETS.dob, items: [] };
  try {
    const street = building.street.replace(/\s+(STREET|ST)$/i, "");
    const rows = await soql(DATASETS.dob, {
      $select: "violation_type,violation_category,issue_date,disposition_comments",
      $where: `house_number='${building.house}' AND upper(street) like '${street.toUpperCase()}%' AND boro='${building.boroCode}'`,
      $order: "issue_date DESC",
      $limit: "25",
    });
    out.total = rows.length;
    out.items = rows.slice(0, 5).map((r) => ({
      type: r.violation_type,
      category: r.violation_category,
      date: r.issue_date ? `${r.issue_date.slice(0, 4)}-${r.issue_date.slice(4, 6)}-${r.issue_date.slice(6, 8)}` : null,
    }));
    out.operationalMeaning =
      out.total > 0
        ? `${out.total} DOB violation record(s) found. If the field issue involves structural, electrical, or life-safety equipment, link it to this DOB history and verify none of the prior items are unresolved before closing.`
        : "No DOB violations on record for this address.";
  } catch (e) {
    out.error = e.message;
    out.operationalMeaning = "DOB lookup unavailable.";
  }
  return out;
}

export async function enrich(structured, building = DEFAULT_BUILDING) {
  const [threeoneone, hpd, dob] = await Promise.all([
    enrich311(structured, building).catch((e) => ({ source: "NYC 311", error: e.message })),
    enrichHPD(building).catch((e) => ({ source: "HPD", error: e.message })),
    enrichDOB(building).catch((e) => ({ source: "DOB", error: e.message })),
  ]);

  const headline = [];
  if (threeoneone.buildingMatches > 0) headline.push(`${threeoneone.buildingMatches} prior 311 reports here`);
  if (hpd.openCount > 0) headline.push(`${hpd.openCount} open HPD violations`);
  if (dob.total > 0) headline.push(`${dob.total} DOB records`);

  return {
    building,
    headline: headline.length ? headline.join(" · ") : "No significant public records matched",
    sources: [threeoneone, hpd, dob],
  };
}
