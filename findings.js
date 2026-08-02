import { runScan } from "./scanner.js";

/**
 * @typedef {"severe" | "moderate" | "mild"} Severity
 *
 * @typedef {object} FindingLocation
 * @property {string} file
 * @property {number} line
 *
 * @typedef {object} Finding
 * @property {string} id
 * @property {string} [ruleId]
 * @property {Severity} severity
 * @property {string} title
 * @property {string} file
 * @property {number} line
 * @property {FindingLocation[]} locations
 * @property {string} why
 * @property {string} fix
 */

/**
 * Scan a public GitHub repository with local heuristic rules.
 *
 * @param {{ owner: string, repo: string }} repoInfo
 * @param {{ selection?: import("./selection.js").RepoSelection | null }} [options]
 * @returns {Promise<import("./scanner.js").ScanResult>}
 */
export async function scanRepository(repoInfo, options = {}) {
  return runScan(repoInfo, options);
}

/**
 * @param {{ owner: string, repo: string }} repoInfo
 * @param {{ file: string, line: number }} loc
 * @param {string} [defaultBranch]
 */
export function locationToGitHubUrl(repoInfo, loc, defaultBranch = "main") {
  const path = loc.file
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const branch = encodeURIComponent(defaultBranch);
  return `https://github.com/${repoInfo.owner}/${repoInfo.repo}/blob/${branch}/${path}#L${loc.line}`;
}

export function findingToGitHubUrl(repoInfo, finding, defaultBranch = "main") {
  return locationToGitHubUrl(
    repoInfo,
    { file: finding.file, line: finding.line },
    defaultBranch,
  );
}

export function countBySeverity(findings) {
  const counts = { severe: 0, moderate: 0, mild: 0 };
  for (const finding of findings) {
    counts[finding.severity] += 1;
  }
  return counts;
}
