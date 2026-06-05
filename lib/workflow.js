// Workflow recommendation: turns a structured + enriched issue into the
// "what to do Monday morning" output — assignment, escalation, compliance,
// student-facing status, and a closure-verification question.

const ASSIGNMENT_GROUPS = {
  hvac: "Mechanical / HVAC team",
  plumbing: "Plumbing / sanitary crew",
  electrical: "Licensed electrician",
  firelife: "Life-safety + compliance officer",
  elevator: "Certified elevator mechanic (vendor)",
  airquality: "Environmental / ventilation team",
  structural: "Structural / building envelope",
  general: "Facilities triage",
};

function shouldEscalate(structured, enrichment) {
  const reasons = [];
  if (structured.severity === "Critical") reasons.push("Critical severity / safety risk");
  if (structured.categoryKey === "firelife") reasons.push("Life-safety / egress system implicated");
  if (structured.categoryKey === "elevator") reasons.push("Accessibility + mandated inspection");
  if (structured.recurring) reasons.push("Recurring condition — prior fixes did not hold");
  const hpd = enrichment?.sources?.find((s) => /HPD/.test(s.source));
  if (hpd?.openCount > 0) reasons.push(`${hpd.openCount} open HPD violation(s) on the same building`);
  const t311 = enrichment?.sources?.find((s) => /311/.test(s.source));
  if (t311?.buildingMatches > 0) reasons.push("Prior 311 history at this address");
  return reasons;
}

function studentMessage(structured) {
  const eta =
    structured.urgency === "Immediate"
      ? "We've flagged this as urgent and a team is being dispatched now."
      : structured.urgency === "Same day"
      ? "Thanks — we've logged this and it's queued for today."
      : "Thanks for reporting — this is logged and scheduled for the next maintenance visit.";
  return `Got it. We understood this as a ${structured.category.toLowerCase()} issue at ${structured.location}. ${eta} We'll check back with you to confirm it's actually fixed.`;
}

export function recommend(structured, enrichment) {
  const escalation = shouldEscalate(structured, enrichment);
  const assignment = ASSIGNMENT_GROUPS[structured.categoryKey] || ASSIGNMENT_GROUPS.general;

  return {
    cleanedWorkOrder: structured.cleanDescription,
    severity: structured.severity,
    urgency: structured.urgency,
    assignmentGroup: assignment,
    assetTags: structured.assetCategories,
    locationTag: structured.location,
    complianceImplications: structured.obligations,
    publicDataReferences: (enrichment?.sources || [])
      .filter((s) => !s.error)
      .map((s) => ({ source: s.source, meaning: s.operationalMeaning })),
    evidenceChecklist: structured.missingInfo,
    suggestedNextActions: structured.nextSteps || [],
    escalate: escalation.length > 0,
    escalationReasons: escalation,
    studentStatusMessage: studentMessage(structured),
    closureQuestion:
      "Following up on your report — is this now: (a) Fixed, (b) Still happening, or (c) Worse? Your answer updates the work order.",
  };
}
