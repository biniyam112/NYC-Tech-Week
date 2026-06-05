// Field-truth structuring engine.
// Turns a messy plain-English observation into a structured operational record.
// Uses an LLM when OPENAI_API_KEY is present; otherwise a deterministic
// rule-based classifier that still produces a strong, demoable result.

const CATEGORIES = [
  {
    key: "hvac",
    label: "HVAC / Heating / Cooling",
    match: /\b(hot|cold|heat|heating|ac|a\/c|air\s*condition|hvac|temperature|stuffy|freezing|boiler|radiator|thermostat|ahu|vent|airflow|warm|chilly)\b/i,
    assetCategories: ["Air handling unit", "Boiler", "Thermostat", "Damper / actuator", "Steam valve"],
    rootCauses: ["Airflow imbalance", "Failed actuator/damper", "Sensor drift", "Schedule mismatch", "Boiler/valve fault"],
    obligations: ["Occupant comfort", "Ventilation code", "Indoor air quality", "Occupancy/health impact"],
    nyc311: ["HEAT/HOT WATER", "HEATING"],
    nextSteps: ["Verify supply air temperature", "Inspect damper/actuator position", "Compare BMS trend data", "Check schedule vs occupancy"],
  },
  {
    key: "plumbing",
    label: "Plumbing / Sanitary / Drainage",
    match: /\b(leak|water|wet|drip|flood|sewage|sewer|drain|toilet|sink|faucet|pipe|plumb|backup|smell.*sewage|odou?r|trap|overflow|clog)\b/i,
    assetCategories: ["Floor drain", "Sanitary line", "Trap primer", "Fixture / valve", "Vent stack"],
    rootCauses: ["Blocked/failed drain", "Trap seal loss (sewer gas)", "Supply leak", "Venting issue", "Backflow"],
    obligations: ["Sanitation", "Plumbing code", "Water intrusion", "Student/occupant experience"],
    nyc311: ["PLUMBING", "WATER LEAK", "SEWER", "WATER SYSTEM"],
    nextSteps: ["Inspect floor drain & trap seal", "Check for multiple affected fixtures", "Verify no spread to electrical/egress", "Review prior plumbing work orders"],
  },
  {
    key: "electrical",
    label: "Electrical / Power",
    match: /\b(electric|power|outlet|spark|wire|wiring|breaker|panel|outage|shock|burn(ing)?\s*smell|flicker|short|voltage)\b/i,
    assetCategories: ["Switchboard / panel", "Branch circuit", "Outlet / receptacle", "Lighting circuit"],
    rootCauses: ["Overloaded circuit", "Loose/failed connection", "Water intrusion near equipment", "Failed breaker"],
    obligations: ["Electrical safety", "Fire/life safety", "Water + electrical escalation"],
    nyc311: ["ELECTRIC", "ELECTRICAL"],
    nextSteps: ["De-energize if smoke/burning odor", "Inspect panel & connections", "Check for water near equipment", "Escalate if life-safety risk"],
  },
  {
    key: "firelife",
    label: "Fire / Life-Safety / Egress",
    match: /\b(fire|smoke|alarm|exit|egress|stair(well)?|door.*(latch|close)|sprinkler|extinguisher|emergency\s*light|evacuat|blocked)\b/i,
    assetCategories: ["Exit sign / emergency light", "Fire door", "Sprinkler", "Alarm device", "Egress path"],
    rootCauses: ["Failed device/battery", "Obstructed egress", "Door fails to latch/self-close", "Disabled alarm"],
    obligations: ["Life safety", "Egress requirement", "Fire code", "Inspection requirement"],
    nyc311: ["Safety", "Fire Safety Director - F58"],
    nextSteps: ["Treat as high priority", "Verify egress is unobstructed", "Test device/battery", "Link to inspection compliance before closure"],
    forceSeverity: "High",
  },
  {
    key: "elevator",
    label: "Elevator / Vertical Transport",
    match: /\b(elevator|lift|escalator|stuck|cab|hoist)\b/i,
    assetCategories: ["Elevator car", "Hoist machine", "Controller", "Door operator"],
    rootCauses: ["Door fault", "Controller fault", "Overdue maintenance", "Safety circuit trip"],
    obligations: ["Accessibility (ADA)", "Inspection requirement", "Service history"],
    nyc311: ["ELEVATOR"],
    nextSteps: ["Check service history & last inspection", "Confirm accessibility impact", "Dispatch certified mechanic", "Escalate if entrapment risk"],
    forceSeverity: "High",
  },
  {
    key: "airquality",
    label: "Air Quality / Ventilation",
    match: /\b(air\s*quality|mold|mould|musty|dust|fumes|smell|odou?r|stuffy|co2|carbon\s*monoxide|ventilation|breathe)\b/i,
    assetCategories: ["Ventilation / AHU", "Filtration", "Exhaust fan"],
    rootCauses: ["Inadequate ventilation", "Filter failure", "Moisture/mold", "Contaminant source"],
    obligations: ["Ventilation", "Indoor air quality", "Occupant health"],
    nyc311: ["Air Quality", "Indoor Air Quality"],
    nextSteps: ["Verify ventilation/exhaust operation", "Inspect filtration", "Check for moisture/mold source", "Assess occupant health impact"],
  },
  {
    key: "structural",
    label: "Structural / Building Envelope",
    match: /\b(crack|ceiling|wall|floor|collapse|fall(ing)?|debris|brick|facade|window|roof|tile|hole)\b/i,
    assetCategories: ["Ceiling / wall", "Window", "Roof / facade", "Floor surface"],
    rootCauses: ["Water damage", "Material failure", "Impact damage", "Aging structure"],
    obligations: ["Building code", "Occupant safety", "Facade inspection (where applicable)"],
    nyc311: ["GENERAL", "Building/Use"],
    nextSteps: ["Cordon off if falling hazard", "Assess water source", "Document with photo", "Escalate if structural"],
  },
];

const DEFAULT_CATEGORY = {
  key: "general",
  label: "General Facilities",
  assetCategories: ["Unassigned"],
  rootCauses: ["Undetermined — needs field confirmation"],
  obligations: ["Facility SOP"],
  nyc311: ["GENERAL"],
  nextSteps: ["Dispatch for field assessment", "Capture photo and exact location", "Reclassify after inspection"],
};

const URGENCY = {
  immediate: /\b(gas|smoke|fire|spark|shock|flood|sewage|collapse|stuck|trapped|no\s*power|carbon\s*monoxide|burning)\b/i,
  high: /\b(leak|wet|cold|hot|no\s*heat|broken|not\s*working|fail|alarm|exit|door)\b/i,
};

const RECURRENCE = /\b(again|still|recurring|every|repeated|weeks?|months?|always|keeps|same\s*(issue|problem)|been\s+(like|broken))\b/i;
const DURATION = /\b(\d+\s*(day|week|month|hour)s?|since\s+\w+|all\s+(day|week)|for\s+\w+)\b/i;
const AFFECTED = /\b(students?|teachers?|residents?|tenants?|staff|everyone|class(room)?|patients?|workers?|occupants?|kids?|children)\b/i;

function classify(text) {
  for (const c of CATEGORIES) if (c.match.test(text)) return c;
  return DEFAULT_CATEGORY;
}

function deriveSeverity(text, category) {
  if (category.forceSeverity) return category.forceSeverity;
  if (URGENCY.immediate.test(text)) return "Critical";
  if (RECURRENCE.test(text)) return "High";
  if (URGENCY.high.test(text)) return "Medium";
  return "Low";
}

function deriveUrgency(text) {
  if (URGENCY.immediate.test(text)) return "Immediate";
  if (URGENCY.high.test(text) || RECURRENCE.test(text)) return "Same day";
  return "Routine (next visit)";
}

function extractLocation(text, fallback) {
  const m =
    text.match(/\b(room|rm|floor|fl|suite|apt|apartment|unit|stair(?:well)?|basement|lobby|hallway|bathroom|restroom|gym|cafeteria|roof|boiler\s*room|mechanical\s*room)\s*#?\s*([\w-]+)?/i) ||
    text.match(/\b(\d{1,3})(?:st|nd|rd|th)\s*floor\b/i);
  if (m) return m[0].replace(/\s+/g, " ").trim();
  return fallback || "Not specified — needs confirmation";
}

function missingInfo(text, structured) {
  const missing = [];
  if (!/\bphoto|picture|image|attached\b/i.test(text)) missing.push("Photo / visual evidence");
  if (!DURATION.test(text)) missing.push("How long has it been happening?");
  if (!/\b(still|ongoing|now|currently|resolved|stopped)\b/i.test(text)) missing.push("Is it still happening right now?");
  if (structured.location.startsWith("Not specified")) missing.push("Exact location (floor/room/zone)");
  if (!AFFECTED.test(text)) missing.push("Who/how many are affected?");
  return missing;
}

function followUpQuestions(category) {
  const base = ["Can you add a photo of the issue?", "Is this affecting more than one room/fixture?"];
  if (category.key === "hvac") base.push("Is it worse at a particular time of day?");
  if (category.key === "plumbing") base.push("Is water actively spreading, or contained?");
  if (category.key === "firelife") base.push("Is the exit/egress path currently blocked?");
  return base;
}

function rewriteDescription(text, structured) {
  const parts = [];
  parts.push(`${structured.category} issue reported at ${structured.location}.`);
  parts.push(`Observed: "${text.trim()}"`);
  if (structured.recurring) parts.push("Reporter indicates this is a recurring condition.");
  if (structured.affected) parts.push(`Affected: ${structured.affected}.`);
  parts.push(`Likely root-cause categories: ${structured.rootCauses.slice(0, 3).join(", ")}.`);
  parts.push(`Recommended verification: ${structured.nextSteps.slice(0, 2).join("; ")}.`);
  return parts.join(" ");
}

export function ruleStructure(text, context = {}) {
  const category = classify(text);
  const severity = deriveSeverity(text, category);
  const urgency = deriveUrgency(text);
  const location = extractLocation(text, context.location);
  const affectedMatch = text.match(AFFECTED);
  const structured = {
    issueType: category.label,
    category: category.label,
    categoryKey: category.key,
    location,
    severity,
    urgency,
    assetCategories: category.assetCategories,
    rootCauses: category.rootCauses,
    obligations: category.obligations,
    nextSteps: category.nextSteps || [],
    nyc311Types: category.nyc311,
    recurring: RECURRENCE.test(text),
    affected: affectedMatch ? affectedMatch[0] : null,
    evidenceQuality: /\bphoto|picture|image\b/i.test(text) ? "Has photo" : "Text only — weak",
  };
  structured.missingInfo = missingInfo(text, structured);
  structured.followUpQuestions = followUpQuestions(category);
  structured.cleanDescription = rewriteDescription(text, structured);
  structured.engine = "rule-based";
  return structured;
}

// Optional LLM upgrade — used only if OPENAI_API_KEY is set.
async function llmStructure(text, context) {
  const key = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
  const sys = `You are a facilities operations analyst. Convert a field observation into a structured JSON work-order record. Respond with ONLY JSON matching this shape:
{"issueType":string,"category":string,"location":string,"severity":"Critical|High|Medium|Low","urgency":string,"assetCategories":string[],"rootCauses":string[],"obligations":string[],"nyc311Types":string[],"recurring":boolean,"affected":string|null,"evidenceQuality":string,"missingInfo":string[],"followUpQuestions":string[],"cleanDescription":string}`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `Observation: "${text}"\nContext: ${JSON.stringify(context)}` },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const json = await res.json();
  const parsed = JSON.parse(json.choices[0].message.content);
  parsed.categoryKey = ruleStructure(text, context).categoryKey;
  parsed.engine = `openai:${model}`;
  return parsed;
}

export async function structure(text, context = {}) {
  if (process.env.OPENAI_API_KEY) {
    try {
      return await llmStructure(text, context);
    } catch {
      /* fall back to rule-based on any LLM error */
    }
  }
  return ruleStructure(text, context);
}
