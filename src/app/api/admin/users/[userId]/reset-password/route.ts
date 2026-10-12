import { randomBytes } from "node:crypto";
import { isErrorResponse, requireAdmin } from "@/lib/admin-api";
import { PasswordBusyError, hashPassword, passwordBusyResponse } from "@/lib/auth";
import {
  deleteSessionsForUser,
  getUserById,
  setUserPassword,
} from "@/lib/db/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Generates a temporary password, shows it to the admin exactly once, and
// forces the user through the change-password flow on their next login. All
// of the user's sessions are revoked.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> },
) {
  const admin = await requireAdmin();
  if (isErrorResponse(admin)) {
    return admin;
  }
  const { userId } = await params;
  const target = getUserById(userId);
  if (!target) {
    return Response.json({ error: "User not found." }, { status: 404 });
  }
  const tempPassword = randomBytes(9).toString("base64url");
  let hash: string;
  try {
    hash = await hashPassword(tempPassword);
  } catch (error) {
    if (error instanceof PasswordBusyError) {
      return passwordBusyResponse();
    }
    throw error;
  }
  setUserPassword(target.id, hash, true);
  deleteSessionsForUser(target.id);
  return Response.json({ tempPassword });
}
