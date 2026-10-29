import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { isServerId, workDir } from "@/lib/addons/paths";

// A run of an addon on somebody's behalf: reading a rulebook, building a
// map. They take minutes, so the route that starts one answers at once with
// the task's id and the page asks after it until it is done.
//
// Held in memory: a task is worth nothing after a restart (its program died
// with the server), and what it produced is written somewhere real (a
// workshop, a prepared map) when it finishes. Its working folder goes when
// it is collected, and a sweep at the first task after a start clears any a
// crash left behind.

export type TaskKind = "workshop-import" | "map" | "setup";
export type TaskStatus = "running" | "done" | "failed" | "cancelled";

export type AddonTask = {
  id: string;
  kind: TaskKind;
  addonId: string;
  addonName: string;
  contributionId: string;
  title: string;
  userId: string;
  campaignId: string;
  status: TaskStatus;
  progress: { fraction: number | null; message: string };
  error: string;
  notes: string[];
  // What a finished task produced, for the page that started it.
  result: Record<string, unknown> | null;
  startedAt: number;
  finishedAt: number;
  dir: string;
  controller: AbortController;
};

// What a page is shown: no folder, no controller.
export type TaskView = Omit<AddonTask, "dir" | "controller" | "userId">;

const KEEP_FINISHED_MS = 60 * 60_000;
const MAX_RUNNING_PER_USER = 2;
const MAX_RUNNING = 6;

type TaskState = { tasks: Map<string, AddonTask>; swept: boolean };

declare global {
  var __odmAddonTasks: TaskState | undefined;
}

function store(): TaskState {
  return (globalThis.__odmAddonTasks ??= { tasks: new Map(), swept: false });
}

export function taskView(task: AddonTask): TaskView {
  return {
    id: task.id,
    kind: task.kind,
    addonId: task.addonId,
    addonName: task.addonName,
    contributionId: task.contributionId,
    title: task.title,
    campaignId: task.campaignId,
    status: task.status,
    progress: task.progress,
    error: task.error,
    notes: task.notes,
    result: task.result,
    startedAt: task.startedAt,
    finishedAt: task.finishedAt,
  };
}

async function collect(now = Date.now()) {
  const state = store();
  for (const task of [...state.tasks.values()]) {
    if (task.status !== "running" && now - task.finishedAt > KEEP_FINISHED_MS) {
      state.tasks.delete(task.id);
      await rm(task.dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  if (!state.swept) {
    state.swept = true;
    // Folders from a run the server did not live to finish.
    const live = new Set(state.tasks.keys());
    const names = await readdir(workDir()).catch(() => [] as string[]);
    for (const name of names) {
      if (!live.has(name) && isServerId(name)) {
        await rm(path.join(workDir(), name), { recursive: true, force: true }).catch(() => undefined);
      }
    }
  }
}

export type NewTask = Pick<AddonTask, "kind" | "addonId" | "addonName" | "contributionId" | "title" | "userId" | "campaignId">;

export async function createTask(input: NewTask): Promise<{ ok: true; task: AddonTask } | { ok: false; error: string }> {
  await collect();
  const running = [...store().tasks.values()].filter((task) => task.status === "running");
  if (running.filter((task) => task.userId === input.userId).length >= MAX_RUNNING_PER_USER) {
    return { ok: false, error: "You already have two addon runs going. Wait for one to finish." };
  }
  if (running.length >= MAX_RUNNING) {
    return { ok: false, error: "This server is busy with other addon runs. Try again in a few minutes." };
  }
  const id = crypto.randomUUID();
  const dir = path.join(workDir(), id);
  await mkdir(path.join(dir, "input"), { recursive: true });
  await mkdir(path.join(dir, "output"), { recursive: true });
  const task: AddonTask = {
    ...input,
    id,
    status: "running",
    progress: { fraction: null, message: "Starting" },
    error: "",
    notes: [],
    result: null,
    startedAt: Date.now(),
    finishedAt: 0,
    dir,
    controller: new AbortController(),
  };
  store().tasks.set(id, task);
  return { ok: true, task };
}

export function getTask(id: string): AddonTask | null {
  return store().tasks.get(id) ?? null;
}

// A task its owner (or an admin) may see.
export function taskFor(id: string, user: { id: string; isAdmin?: boolean }): AddonTask | null {
  const task = getTask(id);
  return task && (task.userId === user.id || user.isAdmin) ? task : null;
}

export function reportProgress(task: AddonTask, update: { progress: number; total?: number; message?: string }) {
  if (task.status !== "running") return;
  const fraction = update.total && update.total > 0 ? Math.min(1, Math.max(0, update.progress / update.total)) : null;
  task.progress = { fraction, message: update.message?.trim() || task.progress.message };
}

export function finishTask(task: AddonTask, outcome: { result: Record<string, unknown>; notes?: string[] } | { error: string }) {
  if (task.status !== "running") return;
  task.finishedAt = Date.now();
  if ("error" in outcome) {
    task.status = task.controller.signal.aborted ? "cancelled" : "failed";
    task.error = task.controller.signal.aborted ? "Cancelled." : outcome.error;
    return;
  }
  task.status = "done";
  task.result = outcome.result;
  task.notes = outcome.notes ?? [];
  task.progress = { fraction: 1, message: "Done" };
}

export function cancelTask(task: AddonTask) {
  if (task.status === "running") task.controller.abort();
}

export function outputDir(task: AddonTask): string {
  return path.join(task.dir, "output");
}

export function inputDir(task: AddonTask): string {
  return path.join(task.dir, "input");
}
