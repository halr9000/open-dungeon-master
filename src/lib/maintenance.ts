// The server's "stop taking play" switch. A live restore replaces the
// database file under a handle that is still open: anything written after
// that went to the old file and was lost at the restart, silently. Now the
// restore turns this on first, and until the process restarts every API and
// media request is answered 503 (src/proxy.ts), every live stream is closed
// and the database refuses to open (src/lib/db/core.ts).
//
// No "@/" imports: the proxy and the database core both read it.

export type MaintenanceState = { reason: string; since: string };

declare global {
  var __odmMaintenance: MaintenanceState | undefined;
}

export function enterMaintenance(reason: string): MaintenanceState {
  globalThis.__odmMaintenance ??= { reason, since: new Date().toISOString() };
  return globalThis.__odmMaintenance;
}

export function maintenanceState(): MaintenanceState | null {
  return globalThis.__odmMaintenance ?? null;
}

// Tests and a restore that failed before touching any file.
export function leaveMaintenance(): void {
  globalThis.__odmMaintenance = undefined;
}
