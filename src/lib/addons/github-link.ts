// A GitHub link as an admin or an addon author pastes it: owner/repo, the
// repository's page, a release page, or a folder at a branch or commit.
// Pure, so the server (src/lib/addons/github.ts) and the catalog tool
// (scripts/addon-catalog.mjs) read links the same way.

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const REF = /^[A-Za-z0-9_./-]{1,200}$/;

export type GitHubLink = {
  owner: string;
  repo: string;
  // "latest" for a bare repository link (its newest release, else its
  // default branch), "release" for a release page, "ref" for a tree link.
  mode: "latest" | "release" | "ref";
  ref: string;
  path: string;
};

// Reads the link forms people paste: owner/repo, the repository page, a
// release page, or a folder at a branch (".../tree/<branch>/<folder>").
export function parseGitHubLink(input: string): GitHubLink | null {
  let text = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  if (!text) return null;
  if (!/^https?:\/\//.test(text)) {
    if (!/^[^/]+\/[^/]+$/.test(text)) return null;
    text = `https://github.com/${text}`;
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return null;
  const [owner, repo, kind, ...rest] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
  if (!kind) return { owner, repo, mode: "latest", ref: "", path: "" };
  if (kind === "releases" && rest[0] === "tag" && rest[1] && REF.test(rest[1])) {
    return { owner, repo, mode: "release", ref: decodeURIComponent(rest[1]), path: "" };
  }
  if (kind === "tree" && rest[0] && REF.test(rest[0])) {
    const path = rest.slice(1).map(decodeURIComponent).join("/");
    if (path && (path.split("/").some((part) => part === ".." || part === ".") || !REF.test(path))) return null;
    return { owner, repo, mode: "ref", ref: decodeURIComponent(rest[0]), path };
  }
  return null;
}
