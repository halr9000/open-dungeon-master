import os from "node:os";
import { hostPlatform } from "@/lib/host-platform";
import { hostAvailability } from "@/lib/harness/discover";
import { serverEnv } from "@/lib/server-env";

// Whether this server runs addons at all, and why not when it does not.
//
// Addons are programs, so they need a computer that can start them: a
// server on Linux, Windows or macOS, including the desktop app's own world.
// The Android app's world runs this server on the phone, which cannot start
// a Python or Blender process and has no admin to look after one, so addons
// are off there for now. An operator can also switch them off outright with
// ODM_ADDONS=off.

export type AddonSupport = {
  supported: boolean;
  reason: string;
  // A container can still run node addons and anything installed inside the
  // image; the panel says so rather than refusing.
  note: string;
};

export function addonSupport(): AddonSupport {
  if (serverEnv("ODM_ADDONS").trim().toLowerCase() === "off") {
    return { supported: false, reason: "The operator switched addons off on this server (ODM_ADDONS=off).", note: "" };
  }
  const platform = hostPlatform();
  if (platform === "android") {
    return { supported: false, reason: "Addons are not available in the Android app's world yet.", note: "" };
  }
  if (platform !== "linux" && platform !== "win32" && platform !== "darwin") {
    return { supported: false, reason: `Addons run on Linux, Windows and macOS; this server is on ${platform}.`, note: "" };
  }
  const availability = hostAvailability();
  const note =
    availability === "container"
      ? "This server runs in a container: an addon can only start programs installed inside the image (Node addons always work)."
      : availability === "sandboxed-package"
        ? "This server runs in a sandboxed package: programs outside the sandbox (Blender, Python) may not be reachable."
        : "";
  return { supported: true, reason: "", note };
}

export function hostArch(): string {
  return os.arch();
}
