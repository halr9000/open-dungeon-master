import { compareVersions, type AddonManifest, type AddonRequirement } from "@/lib/addons/manifest";
import { buildChildEnv } from "@/lib/harness/child-env";
import { childPath, findBinary } from "@/lib/harness/discover";
import { runProgram } from "@/lib/harness/process";
import { onWindows } from "@/lib/host-platform";
import type { AddonState } from "@/lib/addons/store";

// The programs an addon needs on this computer, looked for before it is
// started: its own `requires` list, and Python for a python addon. The
// panel shows each with where it was found, the version it reported, and
// what to do when it is missing or too old.

export type RequirementCheck = {
  program: string;
  found: string;
  version: string;
  ok: boolean;
  problem: string;
  hint: string;
  url: string;
};

const PROBE_TIMEOUT_MS = 8_000;

function versionFrom(output: string, pattern: string): string {
  if (!pattern) return "";
  try {
    const match = new RegExp(pattern).exec(output);
    return match?.[1] ?? "";
  } catch {
    return "";
  }
}

export async function checkRequirement(
  requirement: AddonRequirement,
  settings: AddonState["settings"],
): Promise<RequirementCheck> {
  const explicit = requirement.setting ? String(settings[requirement.setting] ?? "") : "";
  const base = { program: requirement.program, hint: requirement.hint, url: requirement.url ?? "" };
  const found = await findBinary([requirement.program, ...requirement.aliases], explicit);
  if (!found) {
    return {
      ...base,
      found: "",
      version: "",
      ok: false,
      problem: explicit
        ? `Nothing runnable at ${explicit}.`
        : `${requirement.program} was not found on this computer.`,
    };
  }
  if (!requirement.versionPattern) {
    return { ...base, found, version: "", ok: true, problem: "" };
  }
  // The same allowlisted environment an addon gets: a version probe has no
  // business seeing the server's keys either.
  const env = buildChildEnv(process.env as Record<string, string | undefined>, "addon", await childPath(found));
  const probe = await runProgram(found, requirement.versionArgs, env, PROBE_TIMEOUT_MS);
  const version = versionFrom(`${probe.stdout}\n${probe.stderr}`, requirement.versionPattern);
  if (!version) {
    return { ...base, found, version: "", ok: false, problem: `${requirement.program} did not report a version.` };
  }
  if (requirement.minVersion && compareVersions(version, requirement.minVersion) < 0) {
    return {
      ...base,
      found,
      version,
      ok: false,
      problem: `${requirement.program} ${version} is here; this addon needs ${requirement.minVersion} or later.`,
    };
  }
  return { ...base, found, version, ok: true, problem: "" };
}

// Python, as a python addon's runtime: python3 first, then python, and on
// Windows the py launcher's python too.
export function pythonRequirement(minVersion: string): AddonRequirement {
  return {
    program: "python3",
    aliases: onWindows() ? ["python", "py"] : ["python"],
    versionArgs: ["--version"],
    versionPattern: "Python (\\d+\\.\\d+(?:\\.\\d+)?)",
    minVersion,
    hint: `Install Python ${minVersion} or later.`,
    url: "https://www.python.org/downloads/",
  };
}

export async function checkRequirements(manifest: AddonManifest, settings: AddonState["settings"]): Promise<RequirementCheck[]> {
  const list = [...manifest.requires];
  if (manifest.runtime.kind === "python") {
    list.unshift(pythonRequirement(manifest.runtime.minVersion));
  }
  return Promise.all(list.map((requirement) => checkRequirement(requirement, settings)));
}
