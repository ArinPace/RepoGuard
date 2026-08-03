// GitHub REST helpers for public repos (no auth).
// Unauthenticated API: ~60 requests/hour — keep file caps low in the scanner.

import {
  isScannablePath,
  scannableExtensionList as listExtensions,
} from "./languages.js";

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** Max subdirectory tree fetches when GitHub returns a truncated recursive tree. */
const MAX_EXTRA_TREE_FETCHES = 12;

export const REQUIRED_ORIGINS = [
  "https://api.github.com/*",
  "https://raw.githubusercontent.com/*",
];

export const GITHUB_ACCESS_HELP =
  "RepoGuard needs access to api.github.com and raw.githubusercontent.com. Open chrome://extensions → RepoGuard → Details → Site access, allow those sites, then try again.";

/**
 * Unpacked installs often grant host access quietly (no Chrome prompt).
 * If the user revoked site access, request it again when possible (side panel
 * user-gesture). From a service worker, request may be unavailable — then
 * we surface the guided Site access message instead of a generic network error.
 */
export async function ensureGitHubAccess() {
  if (!chrome.permissions?.contains) return true;

  const have = await chrome.permissions.contains({ origins: REQUIRED_ORIGINS });
  if (have) return true;

  if (chrome.permissions.request) {
    try {
      const granted = await chrome.permissions.request({ origins: REQUIRED_ORIGINS });
      if (granted) return true;
    } catch {
      /* no user gesture / not allowed in this context */
    }
  }

  throw new Error(GITHUB_ACCESS_HELP);
}

export { listExtensions as scannableExtensionList };

const SKIP_DIR_PARTS = new Set([
  "node_modules",
  "dist",
  "build",
  "vendor",
  ".git",
  "coverage",
  "out",
  ".next",
  "target",
  "Pods",
  "__pycache__",
  ".venv",
  "venv",
  "DerivedData",
  ".gradle",
  ".idea",
]);

async function githubFetch(url) {
  let response;
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
  } catch (error) {
    throw new Error(
      `Network error talking to GitHub (${error?.message || error}). Check that RepoGuard has site access to api.github.com (chrome://extensions → RepoGuard → Details → Site access).`,
    );
  }

  if (response.status === 403 || response.status === 429) {
    throw new Error(
      "GitHub API rate limit hit. Wait a bit, or try again later (unauthenticated limit is ~60 requests/hour).",
    );
  }

  if (response.status === 404) {
    throw new Error("Repository not found or not public.");
  }

  if (!response.ok) {
    throw new Error(`GitHub API error (${response.status}).`);
  }

  return response;
}

/**
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<{ defaultBranch: string }>}
 */
export async function getRepo(owner, repo) {
  const response = await githubFetch(`${API}/repos/${owner}/${repo}`);
  const data = await response.json();
  return { defaultBranch: data.default_branch || "main" };
}

function shouldSkipPath(path) {
  const parts = path.split("/");
  for (const part of parts) {
    if (SKIP_DIR_PARTS.has(part)) return true;
  }
  const base = parts[parts.length - 1] || "";
  if (base.endsWith(".min.js") || base.endsWith(".min.css")) return true;
  if (base.startsWith(".") && !base.startsWith(".env")) {
    return true;
  }
  return false;
}

function collectBlobsFromTree(treeItems, pathPrefix = "") {
  const files = [];
  let blobCount = 0;
  const subtrees = [];

  for (const item of treeItems || []) {
    if (!item.path && !item.sha) continue;
    const rel = item.path || "";
    const fullPath = pathPrefix ? `${pathPrefix}/${rel}` : rel;

    if (item.type === "blob") {
      blobCount += 1;
      if (!shouldSkipPath(fullPath) && isScannablePath(fullPath)) {
        files.push({
          path: fullPath,
          size: typeof item.size === "number" ? item.size : null,
        });
      }
    } else if (item.type === "tree" && item.sha && !shouldSkipPath(fullPath)) {
      subtrees.push({ path: fullPath, sha: item.sha });
    }
  }

  return { files, blobCount, subtrees };
}

async function fetchTreeJson(owner, repo, shaOrRef, recursive) {
  const query = recursive ? "?recursive=1" : "";
  const encoded = encodeURIComponent(shaOrRef);
  const url = `${API}/repos/${owner}/${repo}/git/trees/${encoded}${query}`;
  const response = await githubFetch(url);
  return response.json();
}

/**
 * GitHub may set truncated:true on huge recursive trees. Expand a bounded set
 * of top-level folders instead of logging (Chrome treats console.warn as Errors).
 */
async function expandTruncatedTree(owner, repo, rootRef, seedFiles, seedBlobCount) {
  const files = [...seedFiles];
  let blobCount = seedBlobCount;
  let fetches = 0;
  let stillIncomplete = false;
  const seen = new Set(files.map((f) => f.path));

  const root = await fetchTreeJson(owner, repo, rootRef, false);
  fetches += 1;
  const rootParts = collectBlobsFromTree(root.tree || [], "");

  for (const file of rootParts.files) {
    if (!seen.has(file.path)) {
      files.push(file);
      seen.add(file.path);
    }
  }
  blobCount = Math.max(blobCount, rootParts.blobCount);

  for (const sub of rootParts.subtrees) {
    if (fetches >= MAX_EXTRA_TREE_FETCHES) {
      stillIncomplete = true;
      break;
    }
    try {
      const data = await fetchTreeJson(owner, repo, sub.sha, true);
      fetches += 1;
      if (data.truncated) {
        stillIncomplete = true;
      }
      const parts = collectBlobsFromTree(data.tree || [], sub.path);
      blobCount += parts.blobCount;
      for (const file of parts.files) {
        if (!seen.has(file.path)) {
          files.push(file);
          seen.add(file.path);
        }
      }
    } catch {
      stillIncomplete = true;
    }
  }

  return {
    files,
    treeBlobCount: blobCount,
    truncated: stillIncomplete,
  };
}

/**
 * List code-ish blob paths under the default branch.
 * Truncation is handled silently and reported via the returned `truncated` flag.
 */
export async function listCodeFiles(owner, repo, defaultBranch) {
  const data = await fetchTreeJson(owner, repo, defaultBranch, true);
  const collected = collectBlobsFromTree(data.tree || [], "");

  if (!data.truncated) {
    return {
      files: collected.files,
      treeBlobCount: collected.blobCount,
      truncated: false,
    };
  }

  // Prefer the tree SHA when present; fall back to the branch name as a ref.
  const rootRef = data.sha || defaultBranch;
  return expandTruncatedTree(
    owner,
    repo,
    rootRef,
    collected.files,
    collected.blobCount,
  );
}

/**
 * @returns {Promise<string | null>} null if skipped / failed softly
 */
export async function fetchFileText(owner, repo, defaultBranch, path, maxBytes) {
  const encodedPath = path
    .split("/")
    .map(encodeURIComponent)
    .join("/");
  const url = `${RAW}/${owner}/${repo}/${encodeURIComponent(defaultBranch)}/${encodedPath}`;

  let response;
  try {
    response = await fetch(url);
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxBytes) {
    return null;
  }

  const probe = new Uint8Array(
    buffer.slice(0, Math.min(8000, buffer.byteLength)),
  );
  for (const byte of probe) {
    if (byte === 0) return null;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
}
