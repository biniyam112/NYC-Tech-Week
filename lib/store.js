// Tiny JSON-file store for field signals + closure status.
// Survives restarts so the "feedback loop" persists during the demo.
import { readFileSync, writeFileSync, existsSync } from "fs";
import { randomUUID } from "crypto";
import { tmpdir } from "os";
import { join } from "path";

// Vercel (and most serverless hosts) only allow writes to /tmp, and that
// storage is ephemeral per-instance. Locally we keep the durable data/ files.
const onServerless = Boolean(process.env.VERCEL);
const FILE = onServerless ? join(tmpdir(), "cherry-signals.json") : new URL("../data/signals.json", import.meta.url);
const OUTBOX = onServerless ? join(tmpdir(), "cherry-outbox.json") : new URL("../data/outbox.json", import.meta.url);

function readJson(file) {
  try {
    if (!existsSync(file)) return [];
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
}

function writeJson(file, list) {
  try {
    writeFileSync(file, JSON.stringify(list, null, 2));
  } catch {
    /* best-effort */
  }
}

const read = () => readJson(FILE);
const write = (list) => writeJson(FILE, list);

export function listOutbox() {
  return readJson(OUTBOX);
}

export function addOutbox(entry) {
  const all = readJson(OUTBOX);
  const record = { id: randomUUID(), createdAt: new Date().toISOString(), ...entry };
  all.unshift(record);
  writeJson(OUTBOX, all);
  return record;
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
