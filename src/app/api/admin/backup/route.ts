import { isErrorResponse, requireAdmin } from "@/lib/admin-api";
import { BackupError, backupDir, createBackup, currentBackupJob, listBackups } from "@/lib/ops/backup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lists the verified archives in the backup directory (ODM_BACKUP_DIR, by
// default ~/odm-backups, the same place scripts/odm-backup.mjs writes).
export async function GET() {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  return Response.json({ backups: listBackups(), dir: backupDir(), job: currentBackupJob() });
}

// A point-in-time snapshot of the campaign state: the encrypted database
// (VACUUM INTO, so it is consistent even mid-game) plus uploads, generated
// media and .env.server, and the downloaded models only when
// { includeModels: true } asks (they are fetched again on first use). The
// archive contains the database encryption key; treat it as a secret.
export async function POST(request: Request) {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  const body = (await request.json().catch(() => ({}))) as { includeModels?: unknown };
  try {
    const backup = await createBackup({ includeModels: body?.includeModels === true });
    return Response.json({ backup });
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "Backup failed." },
      { status: error instanceof BackupError ? error.status : 500 },
    );
  }
}
