"use client";

import type { TaskView } from "@/lib/addons/tasks";

// Follows an addon run until it finishes, asking once a second and handing
// each answer to `onUpdate` so a card can show how far it has got. Resolves
// with the finished run, or null when the page stopped caring (`live`
// turned false) or lost track of it.

export async function followTask(
  task: TaskView,
  onUpdate: (task: TaskView) => void,
  live: () => boolean,
): Promise<TaskView | null> {
  let current = task;
  let misses = 0;
  while (current.status === "running") {
    if (!live()) return null;
    onUpdate(current);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const response = await fetch(`/api/addons/tasks/${current.id}`).catch(() => null);
    if (!response?.ok) {
      // A blip is tried again; a run the server no longer has is lost.
      misses += 1;
      if (response?.status === 404 || misses >= 5) return null;
      continue;
    }
    misses = 0;
    current = ((await response.json()) as { task: TaskView }).task;
  }
  return live() ? current : null;
}

export async function cancelTask(taskId: string): Promise<void> {
  await fetch(`/api/addons/tasks/${taskId}`, { method: "DELETE" }).catch(() => undefined);
}
