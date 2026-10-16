import { getDatabase, nowIso, parseJson } from "@/lib/db/core";
import type { CoordinationEntry, CoordinationPhase, CoordinationStatus } from "@/lib/dm/coordination-logic";

// The coordinated-actions phases (issue 254), one row each; at most one is
// drafting at a table at a time (src/lib/dm/coordination.ts keeps that).

type PhaseRow = {
  id: string;
  campaign_id: string;
  status: CoordinationStatus;
  opened_by: string;
  prompt: string;
  entries_json: string;
  created_at: string;
  updated_at: string;
  resolved_seq: number | null;
  outcome: string;
};

function mapPhase(row: PhaseRow): CoordinationPhase {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    status: row.status,
    openedBy: row.opened_by,
    prompt: row.prompt,
    entries: parseJson<CoordinationEntry[]>(row.entries_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedSeq: row.resolved_seq,
    outcome: row.outcome,
  };
}

// The newest phase at the table, whatever its state.
export function latestCoordination(campaignId: string): CoordinationPhase | null {
  const row = getDatabase()
    .prepare(`SELECT * FROM coordination_phases WHERE campaign_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1`)
    .get(campaignId) as PhaseRow | undefined;
  return row ? mapPhase(row) : null;
}

export function insertCoordination(input: {
  campaignId: string;
  openedBy: string;
  prompt: string;
  entries: CoordinationEntry[];
}): CoordinationPhase {
  const now = nowIso();
  const id = crypto.randomUUID();
  getDatabase()
    .prepare(
      `INSERT INTO coordination_phases (id, campaign_id, status, opened_by, prompt, entries_json, created_at, updated_at, resolved_seq, outcome)
       VALUES (?, ?, 'drafting', ?, ?, ?, ?, ?, NULL, '')`,
    )
    .run(id, input.campaignId, input.openedBy, input.prompt, JSON.stringify(input.entries), now, now);
  return latestCoordination(input.campaignId)!;
}

export function saveCoordination(phase: CoordinationPhase): CoordinationPhase {
  getDatabase()
    .prepare(
      `UPDATE coordination_phases SET status = ?, prompt = ?, entries_json = ?, updated_at = ?, resolved_seq = ?, outcome = ? WHERE id = ?`,
    )
    .run(phase.status, phase.prompt, JSON.stringify(phase.entries), phase.updatedAt, phase.resolvedSeq, phase.outcome, phase.id);
  return phase;
}

// Whether the DM has narrated since a seq: a resolved plan's block is read
// until it has. An out-of-character answer is not narration.
export function dmNarratedSince(campaignId: string, seq: number): boolean {
  return Boolean(
    getDatabase()
      .prepare(`SELECT 1 FROM campaign_messages WHERE campaign_id = ? AND author_type = 'dm' AND content NOT LIKE '(ooc)%' AND seq > ? LIMIT 1`)
      .get(campaignId, seq),
  );
}

// Whether the line a resolved plan posted first is still in the transcript:
// a rewind past it takes the plan with it.
export function planStillPosted(campaignId: string, seq: number): boolean {
  return Boolean(
    getDatabase().prepare(`SELECT 1 FROM campaign_messages WHERE campaign_id = ? AND seq = ? LIMIT 1`).get(campaignId, seq),
  );
}
