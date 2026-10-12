"use client";

import { Check, Loader2, X } from "lucide-react";
import { useState } from "react";
import { useAmbienceInstall, type AmbienceCounts } from "@/app/admin/useAmbienceInstall";
import { PageSection } from "@/components/PageShell";
import { ui } from "@/lib/ui";

// The sound library in the admin panel: how much of the catalog has audio,
// one button that installs the release's sound pack, and a rescan for files
// dropped into public/ambience by hand. Polls while a pack comes down, the
// way the built-in speech card does. The desktop and phone apps ship
// without the library (it would triple the download), so for them this
// card, and the same button in the table's Sound panel, is how it arrives.

const LAYER: Array<{ key: keyof AmbienceCounts; label: string }> = [
  { key: "bed", label: "Rooms" },
  { key: "music", label: "Music" },
  { key: "sting", label: "Sounds" },
];

export function AmbienceLibraryCard() {
  const { status, error, installing, percent, install, rescan } = useAmbienceInstall();
  const [url, setUrl] = useState("");

  const total = status ? LAYER.reduce((sum, layer) => sum + status.counts[layer.key].total, 0) : 0;
  const have = status ? LAYER.reduce((sum, layer) => sum + status.counts[layer.key].installed, 0) : 0;

  return (
    <PageSection
      id="admin-ambience"
      heading="Sound library"
      glyph="tab-ambience"
      intro="The rooms, music and one-shot sounds every table can play: public-domain and Creative Commons recordings, credited on the licenses page. A server set up from the source has the library already; the desktop and phone apps leave it out to stay small, and one tap here downloads it (about 75 MB, kept across updates). The server can fetch more (docs/configuration.md)."
    >
      <div className="space-y-4">
        {status ? (
          <div className="grid gap-2 sm:grid-cols-3">
            {LAYER.map((layer) => {
              const count = status.counts[layer.key];
              const share = count.total ? count.installed / count.total : 0;
              return (
                <div key={layer.key} className="rounded-lg border border-stone-800 bg-stone-900/60 p-3">
                  <div className="flex items-baseline justify-between">
                    <span className={ui.sectionEyebrow}>{layer.label}</span>
                    <span className="text-sm text-stone-200">
                      {count.installed} of {count.total}
                    </span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-stone-800">
                    <div className="h-full rounded-full bg-amber-400/80 transition-[width] duration-500" style={{ width: `${Math.round(share * 100)}%` }} />
                  </div>
                  <div className="mt-1 text-xs text-stone-500">
                    {count.files} {count.files === 1 ? "file" : "files"}
                  </div>
                </div>
              );
            })}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => install(url)}
            disabled={!status || installing}
            className={ui.btnPrimary}
          >
            {installing ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : null}
            {installing ? `Installing ${percent}%` : have && have === total ? "Reinstall the sound pack" : have ? "Install a sound pack" : "Download the sound library"}
          </button>
          <button type="button" onClick={rescan} disabled={!status || installing} className={ui.btnSecondary}>
            Rescan the folder
          </button>
          {status?.status === "ready" && status.result ? (
            <span className="inline-flex items-center gap-1 text-sm text-emerald-300">
              <Check className="size-4" aria-hidden="true" />
              {status.result.installed} tracks installed{status.result.kept ? `, ${status.result.kept} already here` : ""}
            </span>
          ) : null}
          {status?.status === "error" ? (
            <span className="inline-flex items-center gap-1 text-sm text-red-300">
              <X className="size-4" aria-hidden="true" />
              {status.error}
            </span>
          ) : null}
        </div>

        <label className="block">
          <span className="mb-1 block text-xs text-stone-500">
            Pack URL. Blank takes this release&apos;s own pack{status ? ` (${status.packUrl})` : ""}.
          </span>
          <input
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://.../ambience-pack.zip"
            className={ui.input}
            disabled={installing}
          />
        </label>
        <p className="text-xs leading-5 text-stone-500">
          Tracks dropped into public/ambience by hand show up after a rescan (tavern.mp3, or tavern-2.mp3 for a second take).
          On the server, npm run fetch-ambience resolves the library from OpenGameArt, Kevin MacLeod&apos;s catalogue,
          Wikimedia Commons, Freesound and the Internet Archive.
        </p>
        {error ? <p className="text-sm text-red-300">{error}</p> : null}
      </div>
    </PageSection>
  );
}
