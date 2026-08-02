import { getRepo, listCodeFiles, fetchFileText } from "./githubApi.js";
import { matchLine } from "./rules.js";
import {
  pathMatchesSelection,
  selectionIsEmpty,
} from "./selection.js";

export const MAX_FILES = 40;
export const MAX_FILE_BYTES = 200_000;

const SEVERITY_ORDER = { severe: 0, moderate: 1, mild: 2 };

/**
 * @typedef {import("./findings.js").Finding} Finding
 * @typedef {import("./selection.js").RepoSelection} RepoSelection
 *
 * @typedef {object} ScanResult
 * @property {Finding[]} findings
 * @property {string} defaultBranch
 * @property {number} filesScanned
 * @property {number} filesRead
 * @property {number} filesAvailable
 * @property {number} treeBlobCount
 * @property {boolean} capped
 * @property {boolean} truncated
 * @property {boolean} [selectionFiltered]
 * @property {boolean} [selectionMatchedNone]
 */

/**
 * Merge raw per-line hits so each rule appears once with all locations.
 * @param {Omit<Finding, "locations">[]} raw
 * @returns {Finding[]}
 */
function consolidateFindings(raw) {
  /** @type {Map<string, Finding>} */
  const byRule = new Map();

  for (const hit of raw) {
    const key = hit.ruleId || hit.title;
    let group = byRule.get(key);
    if (!group) {
      group = {
        id: `rule:${key}`,
        ruleId: hit.ruleId,
        severity: hit.severity,
        title: hit.title,
        file: hit.file,
        line: hit.line,
        locations: [],
        why: hit.why,
        fix: hit.fix,
      };
      byRule.set(key, group);
    }
    group.locations.push({ file: hit.file, line: hit.line });
  }

  const findings = [...byRule.values()];
  for (const finding of findings) {
    finding.locations.sort((a, b) => {
      const byFile = a.file.localeCompare(b.file);
      if (byFile !== 0) return byFile;
      return a.line - b.line;
    });
    const first = finding.locations[0];
    finding.file = first.file;
    finding.line = first.line;
  }

  return findings;
}

/**
 * Fetch public repo files and run local heuristic rules.
 *
 * @param {{ owner: string, repo: string }} repoInfo
 * @param {{ selection?: RepoSelection | null }} [options]
 * @returns {Promise<ScanResult>}
 */
export async function runScan(repoInfo, options = {}) {
  const { owner, repo } = repoInfo;
  const selection = options.selection ?? null;
  const useSelection = !selectionIsEmpty(selection);

  const { defaultBranch } = await getRepo(owner, repo);
  const listed = await listCodeFiles(owner, repo, defaultBranch);
  let allFiles = listed.files;

  let selectionFiltered = false;
  let selectionMatchedNone = false;

  if (useSelection) {
    selectionFiltered = true;
    allFiles = allFiles.filter((f) => pathMatchesSelection(f.path, selection));
    if (allFiles.length === 0) {
      selectionMatchedNone = true;
    }
  }

  const sized = allFiles.filter((f) => {
    if (f.size == null) return true;
    return f.size > 0 && f.size <= MAX_FILE_BYTES;
  });
  const capped = sized.length > MAX_FILES;
  const toScan = sized.slice(0, MAX_FILES);

  /** @type {Omit<Finding, "locations">[]} */
  const rawFindings = [];
  let findingSeq = 0;
  let filesRead = 0;

  for (const file of toScan) {
    const text = await fetchFileText(
      owner,
      repo,
      defaultBranch,
      file.path,
      MAX_FILE_BYTES,
    );
    if (text == null) continue;
    filesRead += 1;

    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const lineNumber = i + 1;
      const lineText = lines[i];
      if (lineText.length > 2000) continue;

      const hits = matchLine(file.path, lineNumber, lineText);
      for (const hit of hits) {
        findingSeq += 1;
        rawFindings.push({
          id: `${hit.ruleId}:${file.path}:${lineNumber}:${findingSeq}`,
          ruleId: hit.ruleId,
          severity: hit.severity,
          title: hit.title,
          file: file.path,
          line: lineNumber,
          why: hit.why,
          fix: hit.fix,
        });
      }
    }
  }

  const findings = consolidateFindings(rawFindings);
  findings.sort((a, b) => {
    const bySev = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (bySev !== 0) return bySev;
    return a.title.localeCompare(b.title);
  });

  return {
    findings,
    defaultBranch,
    filesScanned: toScan.length,
    filesRead,
    filesAvailable: sized.length,
    treeBlobCount: listed.treeBlobCount,
    capped,
    truncated: listed.truncated,
    selectionFiltered,
    selectionMatchedNone,
  };
}
