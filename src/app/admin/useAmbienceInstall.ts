"use client";

import { useCallback, useEffect, useState } from "react";

// The sound pack install, as a hook: the admin panel's card and the table's
// Sound panel both offer the same one tap, and poll the same route while a
// pack comes down. Mount it only for an admin; the route answers nobody
// else.

export type AmbienceCounts = Record<"bed" | "music" | "sting", { installed: number; total: number; files: number }>;

export type AmbienceInstallStatus = {
  counts: AmbienceCounts;
  files: number;
  packUrl: string;
  status: "idle" | "installing" | "ready" | "error";
  progress: number;
  error: string;
  result: { installed: number; kept: number } | null;
};

async function request(method: "GET" | "POST", body?: Record<string, unknown>): Promise<AmbienceInstallStatus | string> {
  try {
    const response = await fetch("/api/admin/ambience", {
      method,
      cache: "no-store",
      ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
    });
    const data = (await response.json()) as AmbienceInstallStatus & { error?: string };
    if (!response.ok) {
      return data.error ?? `The server answered ${response.status}.`;
    }
    return data;
  } catch {
    return "The server could not be reached.";
  }
}

export function useAmbienceInstall() {
  const [status, setStatus] = useState<AmbienceInstallStatus | null>(null);
  const [error, setError] = useState("");

  const apply = useCallback((result: AmbienceInstallStatus | string) => {
    if (typeof result === "string") {
      setError(result);
    } else {
      setError("");
      setStatus(result);
    }
  }, []);

  useEffect(() => {
    void request("GET").then(apply);
  }, [apply]);

  const installing = status?.status === "installing";
  useEffect(() => {
    if (!installing) {
      return;
    }
    const timer = window.setInterval(() => void request("GET").then(apply), 1500);
    return () => window.clearInterval(timer);
  }, [installing, apply]);

  // Blank takes the release's own pack.
  const install = useCallback((url?: string) => void request("POST", { action: "install", ...(url?.trim() ? { url: url.trim() } : {}) }).then(apply), [apply]);
  const rescan = useCallback(() => void request("POST", { action: "rescan" }).then(apply), [apply]);

  return {
    status,
    error,
    installing,
    percent: Math.round((status?.progress ?? 0) * 100),
    install,
    rescan,
  };
}
