import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { toolPayload } from "@/lib/addons/contracts";
import { downloadToFile, removeQuietly } from "@/lib/addons/download";
import { findInstalledAddon, hostFacts, needsSetup, readyAddon, type InstalledAddon } from "@/lib/addons/installed";
import { ADDON_API_VERSION, type AddonManifest } from "@/lib/addons/manifest";
import { addonDataDir, resolveInside } from "@/lib/addons/paths";
import { checkRequirement, pythonRequirement } from "@/lib/addons/requirements";
import { addonLog, callAddonTool, stopAddon, venvPython } from "@/lib/addons/runtime";
import { cleanSettings, downloadApplies, effectiveSettings, setupSettingKeys } from "@/lib/addons/settings";
import { addonState, setAddonState, type AddonState } from "@/lib/addons/store";
import { unzipFile } from "@/lib/addons/unzip";
import { cancelTask, createTask, finishTask, getTask, reportProgress, type AddonTask } from "@/lib/addons/tasks";
import { buildChildEnv } from "@/lib/harness/child-env";
import { childPath } from "@/lib/harness/discover";
import { onWindows } from "@/lib/host-platform";

// An addon's setup (the manifest's `setup`), run once per installed version
// as a task the admin follows on the addon's card: its Python environment,
// its downloads, then its own setup tool. Everything is written into the
// addon's data folder, which an update keeps, so a download already there
// with the right checksum is not fetched again. Nothing the setup does
// touches the server's own files.

const STEP_TIMEOUT_MS = 60 * 60_000;


// Runs a program to its end, its output going to the addon's log line by
// line; the last line becomes the task's progress message.
function runLogged(
  id: string,
  task: AddonTask,
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env as NodeJS.ProcessEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let tail = "";
    const onData = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        tail = line.trim().slice(0, 300);
        addonLog(id, `[setup] ${tail}`);
        reportProgress(task, { progress: 0, message: tail });
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), STEP_TIMEOUT_MS);
    const abort = () => child.kill("SIGTERM");
    task.controller.signal.addEventListener("abort", abort, { once: true });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not start ${path.basename(command)}: ${error.message}`));
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      task.controller.signal.removeEventListener("abort", abort);
      if (task.controller.signal.aborted) reject(new Error("Cancelled."));
      else if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} stopped with code ${code}: ${tail}`));
    });
  });
}

async function setupPython(addon: { id: string; dir: string; manifest: AddonManifest; settings: Record<string, string | number | boolean> }, task: AddonTask, dataDir: string) {
  const python = addon.manifest.setup?.python;
  if (!python || addon.manifest.runtime.kind !== "python") return;
  const requirements = resolveInside(addon.dir, python.requirements);
  if (!requirements || !existsSync(requirements)) throw new Error(`Its requirements file ${python.requirements} is not in the package.`);
  let venv = venvPython(addon.id);
  if (!venv) {
    reportProgress(task, { progress: 0, message: "Making its Python environment" });
    const check = await checkRequirement(pythonRequirement(addon.manifest.runtime.minVersion), addon.settings);
    if (!check.ok) throw new Error(`${check.problem} ${check.hint}`.trim());
    const launcher = /(^|[\\/])py(\.exe)?$/i.test(check.found) ? ["-3"] : [];
    const env = buildChildEnv(process.env as Record<string, string | undefined>, "addon", await childPath(check.found));
    await runLogged(addon.id, task, check.found, [...launcher, "-m", "venv", path.join(dataDir, ".venv")], { cwd: dataDir, env });
    venv = venvPython(addon.id);
    if (!venv) throw new Error("Python made no environment (on Debian and Ubuntu, install the python3-venv package).");
  }
  reportProgress(task, { progress: 0, message: "Installing its Python packages" });
  const env = {
    ...buildChildEnv(process.env as Record<string, string | undefined>, "addon", await childPath(venv)),
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
    PIP_NO_INPUT: "1",
  };
  await runLogged(addon.id, task, venv, ["-m", "pip", "install", "-r", requirements], { cwd: addon.dir, env });
}

async function setupDownloads(id: string, manifest: AddonManifest, saved: AddonState["settings"], task: AddonTask, dataDir: string) {
  const facts = hostFacts();
  const platformKey = `${facts.platform}-${facts.arch}`;
  // This computer's downloads, for the settings the admin chose (a `when`
  // reads them as the addon will, defaults filled in).
  const settings = effectiveSettings(manifest.settings, saved);
  const downloads = (manifest.setup?.downloads ?? []).filter((download) => downloadApplies(download, platformKey, settings));
  const markers = path.join(dataDir, ".setup");
  await mkdir(markers, { recursive: true });
  for (const [index, download] of downloads.entries()) {
    const target = resolveInside(dataDir, download.to);
    if (!target || target === dataDir) throw new Error(`Download ${download.id} names a place outside its data folder.`);
    const marker = path.join(markers, `${download.id}.sha256`);
    const done = await readFile(marker, "utf8").catch(() => "");
    if (done.trim() === download.sha256 && existsSync(target)) {
      addonLog(id, `[setup] ${download.id} is already here`);
      continue;
    }
    const part = path.join(markers, `${download.id}.part`);
    const label = `Downloading ${download.id} (${index + 1} of ${downloads.length})`;
    const fetched = await downloadToFile(download.url, part, {
      bytes: download.bytes,
      sha256: download.sha256,
      signal: task.controller.signal,
      onProgress: (received, total) => reportProgress(task, { progress: received, total, message: label }),
    });
    if (!fetched.ok) {
      await removeQuietly(part);
      throw new Error(`${download.id}: ${fetched.error}`);
    }
    reportProgress(task, { progress: 0, message: `Unpacking ${download.id}` });
    await removeQuietly(target);
    if (download.unpack === "none") {
      await mkdir(path.dirname(target), { recursive: true });
      await rename(part, target);
    } else if (download.unpack === "zip") {
      // From the file on disk, entry by entry: a portable program's zip can
      // be gigabytes (src/lib/addons/unzip.ts).
      const unpacked = await unzipFile(part, target, task.controller.signal);
      await removeQuietly(part);
      if (!unpacked.ok) throw new Error(`${download.id}: ${unpacked.error}`);
    } else {
      // tar reads gzip and xz on every platform the server runs on
      // (GNU tar on Linux, bsdtar on macOS and Windows), and refuses
      // absolute paths and ".." on its own.
      await mkdir(target, { recursive: true });
      const env = buildChildEnv(process.env as Record<string, string | undefined>, "addon", process.env.PATH ?? "");
      try {
        await runLogged(id, task, onWindows() ? "tar.exe" : "tar", ["-xf", part, "-C", target], { cwd: target, env });
      } finally {
        await removeQuietly(part);
      }
    }
    await writeFile(marker, download.sha256);
    addonLog(id, `[setup] ${download.id} ready`);
  }
}

async function runSetup(task: AddonTask, id: string) {
  try {
    const addon = findInstalledAddon(id);
    if (!addon?.manifest) throw new Error("That addon cannot be read.");
    const manifest = addon.manifest;
    const dataDir = addonDataDir(id);
    if (!dataDir) throw new Error("That addon has an unusable id.");
    await mkdir(path.join(dataDir, "public"), { recursive: true });
    await stopAddon(id);
    addonLog(id, `[setup] starting setup for ${manifest.version}`);
    await setupPython({ id, dir: addon.dir, manifest, settings: addon.state.settings }, task, dataDir);
    await setupDownloads(id, manifest, addon.state.settings, task, dataDir);
    if (manifest.setup?.tool) {
      reportProgress(task, { progress: 0, message: "Running its own setup" });
      const facts = hostFacts();
      const raw = await callAddonTool(
        id,
        manifest.setup.tool,
        {
          dataDir,
          publicDir: path.join(dataDir, "public"),
          packageDir: addon.dir,
          host: { serverVersion: facts.serverVersion, apiVersion: ADDON_API_VERSION, platform: facts.platform },
        },
        {
          forSetup: true,
          task,
          signal: task.controller.signal,
          onProgress: (update) => reportProgress(task, update),
          sampling: { scope: { userId: task.userId } },
        },
      );
      const payload = toolPayload(raw);
      if (!payload.ok) throw new Error(payload.error);
    }
    await stopAddon(id);
    if (!addonState(id)) throw new Error("It was removed while its setup ran.");
    setAddonState(id, { setupVersion: manifest.version, setupError: "" });
    addonLog(id, "[setup] finished");
    finishTask(task, { result: { version: manifest.version } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await stopAddon(id);
    // Removing the addon cancels its setup; that leaves nothing to note.
    if (addonState(id)) setAddonState(id, { setupError: message.slice(0, 600) });
    addonLog(id, `[setup] failed: ${message}`);
    finishTask(task, { error: message });
  }
}

declare global {
  var __odmAddonSetups: Map<string, string> | undefined;
}

export function runningSetup(id: string): AddonTask | null {
  const current = globalThis.__odmAddonSetups?.get(id);
  const task = current ? getTask(current) : null;
  return task?.status === "running" ? task : null;
}

export function setupRunning(id: string): boolean {
  return Boolean(runningSetup(id));
}

export function cancelSetup(id: string): void {
  const task = runningSetup(id);
  if (task) cancelTask(task);
}

// Starts an addon's setup, or hands back the one already running.
export async function startSetup(id: string, user: { id: string }): Promise<{ ok: true; task: AddonTask } | { ok: false; status: number; error: string }> {
  const running = (globalThis.__odmAddonSetups ??= new Map());
  const existing = runningSetup(id);
  if (existing) return { ok: true, task: existing };
  const addon = findInstalledAddon(id);
  if (!addon?.manifest) return { ok: false, status: 404, error: "That addon is not installed, or its manifest does not read." };
  if (!addon.manifest.setup) return { ok: false, status: 400, error: `${addon.manifest.name} has no setup to run.` };
  // Setup fetches and runs things, so it waits for the same yes as the
  // addon itself: switched on, its permissions accepted.
  const ready = readyAddon(id, { forSetup: true });
  if (!ready.ok) return { ok: false, status: 409, error: ready.error };
  const created = await createTask({
    kind: "setup",
    addonId: id,
    addonName: addon.manifest.name,
    contributionId: "setup",
    title: `Setting up ${addon.manifest.name}`,
    userId: user.id,
    campaignId: "",
  });
  if (!created.ok) return { ok: false, status: 429, error: created.error };
  running.set(id, created.task.id);
  void runSetup(created.task, id);
  return { ok: true, task: created.task };
}


// After an install, an update, or switching an addon on: its setup starts on
// its own when it is due and the addon may run. The task's id, or "".
export async function setupIfDue(id: string, user: { id: string }): Promise<string> {
  const addon = findInstalledAddon(id);
  if (!addon?.manifest || !needsSetup(addon.manifest, addon.state)) return "";
  if (!readyAddon(id, { forSetup: true }).ok) return "";
  const started = await startSetup(id, user);
  return started.ok ? started.task.id : "";
}

// An admin's edit to an addon's settings, as the change it makes to the
// addon's state: the values held to their fields, and the setup made due
// again when a setting it reads changed (a quality tier, a download's
// `when`). Refused while the setup runs, which would otherwise finish on
// the old value and mark itself done.
export function settingsEdit(
  addon: InstalledAddon & { manifest: AddonManifest },
  edits: Record<string, string | number | boolean>,
): { ok: true; patch: Partial<AddonState> } | { ok: false; status: number; error: string } {
  const cleaned = cleanSettings(addon.manifest.settings, addon.state.settings, edits);
  if ("error" in cleaned) return { ok: false, status: 400, error: cleaned.error };
  const patch: Partial<AddonState> = { settings: cleaned.values };
  const before = effectiveSettings(addon.manifest.settings, addon.state.settings);
  const after = effectiveSettings(addon.manifest.settings, cleaned.values);
  const touched = [...setupSettingKeys(addon.manifest)].some((key) => before[key] !== after[key]);
  if (touched && addon.manifest.setup) {
    if (setupRunning(addon.id)) {
      return { ok: false, status: 409, error: "Its setup is running. Change this once it has finished, or stop it first." };
    }
    patch.setupVersion = "";
    patch.setupError = "";
  }
  return { ok: true, patch };
}
