// Tiny JSON-file store for field signals + closure status.
// Survives restarts so the "feedback loop" persists during the demo.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";

const FILE = new URL("../data/signals.json", import.meta.url);

function read() {
  try {
    if (!existsSync(FILE)) return [];
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return [];
  }
}

function write(list) {
  try {
    writeFileSync(FILE, JSON.stringify(list, null, 2));
  } catch {
    /* best-effort */
  }
}

export function listSignals(workOrderId) {
  const all = read();
  return workOrderId ? all.filter((s) => s.workOrderId === workOrderId) : all;
}

export function addSignal(signal) {
  const all = read();
  const record = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    closureStatus: null,
    ...signal,
  };
  all.unshift(record);
  write(all);
  return record;
}

export function setClosure(id, closureStatus) {
  const all = read();
  const rec = all.find((s) => s.id === id);
  if (!rec) return null;
  rec.closureStatus = closureStatus;
  rec.closedAt = new Date().toISOString();
  write(all);
  return rec;
}
