// Pure URL helpers — no Chrome APIs here, so this logic is easy to reason about
// and can be unit-tested later without a browser.

// First path segment on github.com that is a site page, not a user/org name.
const RESERVED_OWNERS = new Set([
  "settings",
  "notifications",
  "marketplace",
  "explore",
  "topics",
  "collections",
  "events",
  "sponsors",
  "login",
  "signup",
  "logout",
  "join",
  "session",
  "auth",
  "apps",
  "features",
  "pricing",
  "enterprise",
  "security",
  "about",
  "contact",
  "customer-stories",
  "organizations",
  "orgs",
  "account",
  "dashboard",
  "new",
  "pulls",
  "issues",
  "codespaces",
  "conversations",
  "search",
  "stars",
  "trending",
  "watching",
  "users",
  "repos",
  "site",
  "home",
  "github-copilot",
]);

/**
 * If urlString is a github.com repo page, return { owner, repo, pathname }.
 * Otherwise return null.
 *
 * Matches:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/blob/main/src/app.js
 *   https://github.com/owner/repo/issues/12
 *
 * Rejects:
 *   https://github.com/
 *   https://github.com/octocat          (profile only)
 *   https://github.com/settings/...
 *   https://gist.github.com/...
 */
export function parseGitHubRepoUrl(urlString) {
  if (!urlString || typeof urlString !== "string") {
    return null;
  }

  let url;
  try {
    url = new URL(urlString);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase();
  if (host !== "github.com" && host !== "www.github.com") {
    return null;
  }

  // pathname like "/owner/repo/blob/main/file.js" → ["owner", "repo", "blob", ...]
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 2) {
    return null;
  }

  const [owner, repoSegment] = parts;
  if (RESERVED_OWNERS.has(owner.toLowerCase())) {
    return null;
  }

  // Repo segment in the URL is the folder name; strip a trailing ".git" if present.
  const repo = repoSegment.replace(/\.git$/i, "");
  if (!owner || !repo) {
    return null;
  }

  // GitHub user/repo names are limited; reject obvious junk.
  const namePattern = /^[A-Za-z0-9_.-]+$/;
  if (!namePattern.test(owner) || !namePattern.test(repo)) {
    return null;
  }

  return {
    owner,
    repo,
    pathname: url.pathname,
  };
}

/**
 * If pathname includes /tree/REF or /blob/REF, return REF; else null.
 * @param {string | undefined} pathname
 */
export function refFromRepoPathname(pathname) {
  if (!pathname || typeof pathname !== "string") return null;
  const parts = pathname.split("/").filter(Boolean);
  // owner, repo, tree|blob, ref, ...
  if (parts.length < 4) return null;
  const kind = parts[2];
  if (kind !== "tree" && kind !== "blob") return null;
  const ref = parts[3];
  if (!ref || ref.includes("..")) return null;
  // Reject obviously encoded path junk; allow common branch chars.
  if (!/^[A-Za-z0-9._/~+-]+$/.test(ref)) return null;
  try {
    return decodeURIComponent(ref);
  } catch {
    return ref;
  }
}

export function formatRepoLabel(repoInfo) {
  return `${repoInfo.owner}/${repoInfo.repo}`;
}
