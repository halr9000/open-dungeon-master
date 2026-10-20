import { currentUser, unauthorized } from "@/lib/auth";
import { cancelTask, taskFor, taskView } from "@/lib/addons/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/addons/tasks/<id>: how an addon run is going, for the person who
// started it (or an admin). DELETE cancels it: the addon is told to stop
// and the run ends as cancelled.

type Params = { params: Promise<{ taskId: string }> };

export async function GET(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const task = taskFor((await params).taskId, user);
  if (!task) return Response.json({ error: "That run is not here any more." }, { status: 404 });
  return Response.json({ task: taskView(task) });
}

export async function DELETE(_request: Request, { params }: Params) {
  const user = await currentUser();
  if (!user) return unauthorized();
  const task = taskFor((await params).taskId, user);
  if (!task) return Response.json({ error: "That run is not here any more." }, { status: 404 });
  cancelTask(task);
  return Response.json({ task: taskView(task) });
}
