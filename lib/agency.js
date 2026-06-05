// Agency routing + email composition.
// Routes a structured issue to the responsible NYC agency and drafts a formal
// complaint/referral email from the structured report + public-data context.
//
// NOTE: the email addresses below are routing placeholders for the demo. NYC
// agencies largely intake via 311 / web forms; the operator should verify the
// destination before a real send. They are intentionally editable in the UI.

export const AGENCIES = {
  hpd: {
    name: "NYC Dept. of Housing Preservation & Development (HPD)",
    email: "complaints@hpd.nyc.gov",
    scope: "Residential building conditions — heat, hot water, plumbing, mold, sanitation.",
  },
  dob: {
    name: "NYC Dept. of Buildings (DOB)",
    email: "complaints@buildings.nyc.gov",
    scope: "Structural, electrical, elevator, and construction/code safety.",
  },
  fdny: {
    name: "Fire Department of New York (FDNY) — Fire Safety",
    email: "firesafety@fdny.nyc.gov",
    scope: "Fire and life-safety systems, egress, alarms, sprinklers.",
  },
  dep: {
    name: "NYC Dept. of Environmental Protection (DEP)",
    email: "311@dep.nyc.gov",
    scope: "Water supply, sewer, and environmental/water-quality issues.",
  },
  dohmh: {
    name: "NYC Dept. of Health & Mental Hygiene (DOHMH)",
    email: "indoorair@health.nyc.gov",
    scope: "Indoor air quality, mold, and environmental health hazards.",
  },
  facilities: {
    name: "327 Cherry Street — Facilities Management",
    email: "facilities@327cherry.com",
    scope: "Internal building operations and maintenance triage.",
  },
};

const ROUTE = {
  hvac: "hpd",
  plumbing: "hpd",
  electrical: "dob",
  firelife: "fdny",
  elevator: "dob",
  airquality: "dohmh",
  structural: "dob",
  general: "facilities",
};

export function routeAgency(structured) {
  const key = ROUTE[structured?.categoryKey] || "facilities";
  return { key, ...AGENCIES[key] };
}

function bulletEnrichment(enrichment) {
  if (!enrichment?.sources) return [];
  return enrichment.sources
    .filter((s) => !s.error && s.operationalMeaning && !/^No /.test(s.operationalMeaning))
    .map((s) => `- ${s.source}: ${s.operationalMeaning}`);
}

export function composeEmailRuleBased({ structured, workflow, enrichment, building, workOrder }) {
  const agency = routeAgency(structured);
  const addr = building
    ? `${building.house} ${building.street}, ${building.borough}, NY ${building.zip}`
    : "327 Cherry Street, Manhattan, NY 10002";

  const subject = `[${addr.split(",")[0]}] ${structured.issueType} — ${structured.location} (${structured.severity})`;

  const enrichLines = bulletEnrichment(enrichment);
  const actions = (workflow?.suggestedNextActions || []).map((a) => `- ${a}`);
  const obligations = (workflow?.complianceImplications || structured.obligations || []).join(", ");

  const lines = [
    `To: ${agency.name}`,
    "",
    `This is a facility-condition report submitted on behalf of ${addr}.`,
    "",
    `ISSUE TYPE: ${structured.issueType}`,
    `LOCATION: ${structured.location}`,
    `SEVERITY / URGENCY: ${structured.severity} / ${structured.urgency}`,
    `RECURRING: ${structured.recurring ? "Yes — prior remediation did not hold." : "Not indicated."}`,
    "",
    "DESCRIPTION:",
    workflow?.cleanedWorkOrder || structured.cleanDescription || "",
  ];

  if (enrichLines.length) {
    lines.push("", "PUBLIC-RECORD CONTEXT:", ...enrichLines);
  }
  if (obligations) {
    lines.push("", `APPLICABLE OBLIGATIONS: ${obligations}`);
  }
  if (actions.length) {
    lines.push("", "REQUESTED / RECOMMENDED ACTION:", ...actions);
  }
  if (workflow?.escalate) {
    lines.push(
      "",
      `ESCALATION: This issue has been flagged for escalation — ${workflow.escalationReasons.join("; ")}.`
    );
  }
  lines.push(
    "",
    "Please advise on inspection scheduling or next steps. We can provide photos and access on request.",
    "",
    `Reference: ${workOrder?.id || "field-report"}`,
    "Submitted via the 327 Cherry Street Facilities Operations system.",
    "Contact: facilities@327cherry.com",
  );

  return {
    agency: agency.name,
    agencyKey: agency.key,
    to: agency.email,
    cc: workflow?.escalate ? [AGENCIES.facilities.email] : [],
    subject,
    body: lines.join("\n"),
    rationale: agency.scope,
    engine: "rule-based",
  };
}

async function composeEmailLLM(payload) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const base = composeEmailRuleBased(payload);
  const sys =
    "You are a facilities operations manager writing a concise, professional complaint/referral email to a NYC agency. Keep it factual, specific, and actionable. Do not give legal advice. Return ONLY JSON: {\"subject\":string,\"body\":string}.";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Agency: ${base.agency}\nDraft to refine:\n${base.body}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const json = await res.json();
  const parsed = JSON.parse(json.choices[0].message.content);
  return { ...base, subject: parsed.subject || base.subject, body: parsed.body || base.body, engine: `openai:${model}` };
}

export async function composeEmail(payload) {
  if (process.env.OPENAI_API_KEY) {
    try {
      return await composeEmailLLM(payload);
    } catch {
      /* fall back */
    }
  }
  return composeEmailRuleBased(payload);
}
