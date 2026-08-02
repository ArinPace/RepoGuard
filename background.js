/**
 * RepoGuard MV3 service worker — runs scans when the popup is closed
 * (e.g. Scan from the floating GitHub selection panel).
 */
import { scanRepository, countBySeverity } from "./findings.js";
import { ensureGitHubAccess } from "./githubApi.js";
import {
  getSelection,
  selectionIsEmpty,
  normalizeFilePath,
  normalizeFolderPrefix,
} from "./selection.js";

export const LAST_SCAN_KEY = "lastScan";

/** @type {Promise<unknown> | null} */
let scanInFlight = null;

/**
 * @param {unknown} raw
 * @returns {import("./selection.js").RepoSelection | null}
 */
function normalizeIncomingSelection(raw) {
  if (!raw || typeof raw !== "object") return null;
  const files = Array.isArray(raw.files)
    ? raw.files.map(normalizeFilePath).filter(Boolean)
    : null;
  const folders = Array.isArray(raw.folders)
    ? raw.folders.map(normalizeFolderPrefix).filter(Boolean)
    : null;
  if (!files || !folders) return null;
  return {
    files: [...new Set(files)].sort(),
    folders: [...new Set(folders)].sort(),
  };
}

/**
 * @param {import("./scanner.js").ScanResult} result
 * @param {{ owner: string, repo: string }} repoInfo
 */
function buildSummary(result, repoInfo) {
  const counts = countBySeverity(result.findings);
  const total = result.findings.length;
  return {
    owner: repoInfo.owner,
    repo: repoInfo.repo,
    total,
    severe: counts.severe,
    moderate: counts.moderate,
    mild: counts.mild,
    filesRead: result.filesRead,
    filesAvailable: result.filesAvailable,
    filesScanned: result.filesScanned,
    treeBlobCount: result.treeBlobCount,
    capped: Boolean(result.capped),
    truncated: Boolean(result.truncated),
    selectionFiltered: Boolean(result.selectionFiltered),
    selectionMatchedNone: Boolean(result.selectionMatchedNone),
    defaultBranch: result.defaultBranch,
  };
}

/**
 * @param {ReturnType<typeof buildSummary>} summary
 */
function summaryMessage(summary) {
  if (summary.selectionMatchedNone) {
    return "Selected paths matched no scannable files. Adjust checkboxes and scan again.";
  }
  if (summary.treeBlobCount === 0) {
    return "Empty file tree from GitHub (empty repo or no files on default branch).";
  }
  if (summary.filesAvailable === 0) {
    return "No scannable file types in the selection.";
  }
  if (summary.filesRead === 0 && summary.filesScanned > 0) {
    return "Could not download file contents. Check Site access on chrome://extensions → RepoGuard.";
  }
  if (summary.total === 0) {
    return `No heuristic matches in ${summary.filesRead} file${summary.filesRead === 1 ? "" : "s"}. Open the popup for details.`;
  }
  return (
    `${summary.total} finding${summary.total === 1 ? "" : "s"}` +
    ` (${summary.severe} severe, ${summary.moderate} moderate, ${summary.mild} mild)` +
    ` · ${summary.filesRead} file${summary.filesRead === 1 ? "" : "s"} read. Open RepoGuard popup for details.`
  );
}

/**
 * Persist scan payload so the popup can show full findings.
 * @param {{ owner: string, repo: string }} repoInfo
 * @param {import("./scanner.js").ScanResult} result
 * @param {ReturnType<typeof buildSummary>} summary
 */
async function storeLastScan(repoInfo, result, summary, scannedAt) {
  await chrome.storage.local.set({
    [LAST_SCAN_KEY]: {
      owner: repoInfo.owner,
      repo: repoInfo.repo,
      scannedAt,
      summary,
      findings: result.findings,
      defaultBranch: result.defaultBranch,
      filesRead: result.filesRead,
      filesAvailable: result.filesAvailable,
      filesScanned: result.filesScanned,
      treeBlobCount: result.treeBlobCount,
      capped: Boolean(result.capped),
      truncated: Boolean(result.truncated),
      selectionFiltered: Boolean(result.selectionFiltered),
      selectionMatchedNone: Boolean(result.selectionMatchedNone),
    },
  });
}

/**
 * Shared scan entry for panel + popup. Serialized via scanInFlight so only one
 * writer updates lastScan at a time.
 *
 * @param {{ owner: string, repo: string }} repoInfo
 * @param {{ selection?: unknown }} [options]
 */
async function runScan(repoInfo, options = {}) {
  const { owner, repo } = repoInfo;
  if (!owner || !repo) {
    return { ok: false, error: "Missing owner/repo for scan." };
  }

  await ensureGitHubAccess();

  // Panel may pass a just-flushed selection. Popup omits it so we always read
  // the latest durable picks from storage (avoids stale popup in-memory state).
  let selection = normalizeIncomingSelection(options.selection);
  if (!selection) {
    selection = await getSelection(owner, repo);
  }

  if (selectionIsEmpty(selection)) {
    return {
      ok: false,
      error: "Select at least one file or folder before scanning.",
    };
  }

  const result = await scanRepository({ owner, repo }, { selection });
  const summary = buildSummary(result, { owner, repo });
  const scannedAt = Date.now();
  await storeLastScan({ owner, repo }, result, summary, scannedAt);

  return {
    ok: true,
    summary,
    message: summaryMessage(summary),
    scannedAt,
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "RG_SCAN") {
    const owner = String(message.owner || "");
    const repo = String(message.repo || "");

    if (scanInFlight) {
      sendResponse({
        ok: false,
        error: "A scan is already running. Wait for it to finish.",
      });
      return false;
    }

    // Panel may include selection; popup should omit it (background re-reads storage).
    const hasSelectionPayload = Object.prototype.hasOwnProperty.call(
      message,
      "selection",
    );

    scanInFlight = runScan(
      { owner, repo },
      hasSelectionPayload ? { selection: message.selection } : {},
    )
      .then((response) => {
        sendResponse(response);
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message || error),
        });
      })
      .finally(() => {
        scanInFlight = null;
      });

    return true; // async sendResponse
  }
});
