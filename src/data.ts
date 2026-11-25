// data.json handling. MERGE, never drop: unknown keys and every saved position survive; only known fields are validated.
import { Quality, isQuality } from "./quality";
import type { Mode, PosMap } from "./scene";
export interface Data { version: 1; mode: Mode; positions: PosMap; quality?: Quality; [extra: string]: unknown; }
export const DEFAULT_DATA = (): Data => ({ version: 1, mode: "brain", positions: {} });
export function mergeData(raw: unknown): Data {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  if (!r || r.version !== 1) return DEFAULT_DATA();
  const out: Data = { ...r, version: 1, mode: r.mode === "universe" ? "universe" : "brain", positions: r.positions && typeof r.positions === "object" ? (r.positions as PosMap) : {} };
  if (isQuality(r.quality)) out.quality = r.quality; else delete out.quality;
  return out;
}
/** Apply a UI state change onto existing data without touching other keys. */
export function applyState(d: Data, s: { mode: Mode; positions: PosMap; quality?: Quality }): Data {
  d.mode = s.mode; d.positions = s.positions; if (s.quality && isQuality(s.quality)) d.quality = s.quality; return d;
}
