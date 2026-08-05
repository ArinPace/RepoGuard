/**
 * RepoGuard MV3 service worker — side panel entry + shared scans.
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

/** Local Docker build agent (bound to loopback only). */
export const AGENT_BASE_URL = "http://127.0.0.1:3847";

/** @type {Promise<unknown> | null} */
let scanInFlight = null;

/**
 * @returns {{
 *   dockerUrl: string,
 *   dockerFilename: string,
 *   nodeUrl: string,
 *   helperPath: string,
 *   helperFilename: string,
 *   os: string,
 * }}
 */
function detectSetupPlatform() {
  const ua = (typeof navigator !== "undefined" && navigator.userAgent) || "";
  const isMac = /Mac|Darwin/i.test(ua);
  const isWin = /Win/i.test(ua);
  const isArm = /ARM|aarch64|Apple Silicon/i.test(ua) || (isMac && !/Intel/i.test(ua));

  if (isMac) {
    return {
      os: "mac",
      dockerUrl: isArm
        ? "https://desktop.docker.com/mac/main/arm64/Docker.dmg"
        : "https://desktop.docker.com/mac/main/amd64/Docker.dmg",
      dockerFilename: "Docker.dmg",
      nodeUrl: "https://nodejs.org/en/download",
      helperPath: "bootstrap/Start-RepoGuard-Agent.command",
      helperFilename: "Start-RepoGuard-Agent.command",
    };
  }

  if (isWin) {
    return {
      os: "windows",
      dockerUrl:
        "https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe",
      dockerFilename: "DockerDesktopInstaller.exe",
      nodeUrl: "https://nodejs.org/en/download",
      helperPath: "bootstrap/Start-RepoGuard-Agent.bat",
      helperFilename: "Start-RepoGuard-Agent.bat",
    };
  }

  return {
    os: "linux",
    dockerUrl: "https://docs.docker.com/desktop/setup/install/linux/",
    dockerFilename: "",
    nodeUrl: "https://nodejs.org/en/download",
    helperPath: "bootstrap/Start-RepoGuard-Agent.command",
    helperFilename: "Start-RepoGuard-Agent.command",
  };
}

/**
 * @param {string} url
 * @param {string} [filename]
 * @returns {Promise<number>}
 */
function downloadUrl(url, filename) {
  return new Promise((resolve, reject) => {
    /** @type {chrome.downloads.DownloadOptions} */
    const opts = { url, saveAs: false };
    if (filename) opts.filename = filename;
    chrome.downloads.download(opts, (downloadId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

/**
 * chrome.downloads often fails on chrome-extension:// URLs with a bogus
 * "Check Internet connection" error. Prefer a data: URL, then GitHub raw.
 * @param {string} helperPath
 * @param {string} helperFilename
 * @returns {Promise<number>}
 */
async function downloadHelperFile(helperPath, helperFilename) {
  const errors = [];

  try {
    const res = await fetch(chrome.runtime.getURL(helperPath));
    if (!res.ok) throw new Error(`extension resource HTTP ${res.status}`);
    const text = await res.text();
    if (!text || text.length < 20) throw new Error("extension resource empty");
    const base64 = btoa(unescape(encodeURIComponent(text)));
    const dataUrl = `data:application/octet-stream;base64,${base64}`;
    return await downloadUrl(dataUrl, helperFilename);
  } catch (error) {
    errors.push(`data:${String(error?.message || error)}`);
  }

  const rawUrl = `https://raw.githubusercontent.com/ArinPace/RepoGuard/main/${helperPath}`;
  try {
    return await downloadUrl(rawUrl, helperFilename);
  } catch (error) {
    errors.push(`raw:${String(error?.message || error)}`);
  }

  throw new Error(`Helper download failed (${errors.join("; ")})`);
}

// Toolbar icon opens the side panel (no popup).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {
    /* older Chromium without the API — ignore */
  });

/**
 * Side panel is GitHub-only. Default off; enable per tab on github.com.
 * Chrome hides the panel when switching to a tab where it is disabled.
 * @param {string | undefined} url
 */
function isGitHubUrl(url) {
  if (!url) return false;
  try {
    const { hostname } = new URL(url);
    return hostname === "github.com" || hostname === "www.github.com";
  } catch {
    return false;
  }
}

/**
 * @param {number} tabId
 * @param {string | undefined} url
 */
async function syncSidePanelForTab(tabId, url) {
  if (isGitHubUrl(url)) {
    await chrome.sidePanel.setOptions({
      tabId,
      path: "sidepanel.html",
      enabled: true,
    });
    return;
  }
  // No readable URL (chrome://, locked tabs, non-granted hosts) → treat as off-site.
  await chrome.sidePanel.setOptions({
    tabId,
    enabled: false,
  });
}

// Global default: disabled until a tab is confirmed on GitHub.
chrome.sidePanel
  .setOptions({ path: "sidepanel.html", enabled: false })
  .catch(() => {});

chrome.tabs.onUpdated.addListener((tabId, _info, tab) => {
  syncSidePanelForTab(tabId, tab?.url).catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs
    .get(tabId)
    .then((tab) => syncSidePanelForTab(tabId, tab?.url))
    .catch(() => {
      chrome.sidePanel.setOptions({ tabId, enabled: false }).catch(() => {});
    });
});

chrome.tabs.query({}).then((tabs) => {
  for (const tab of tabs) {
    if (typeof tab.id === "number") {
      syncSidePanelForTab(tab.id, tab.url).catch(() => {});
    }
  }
}).catch(() => {});

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
    return `No heuristic matches in ${summary.filesRead} file${summary.filesRead === 1 ? "" : "s"}.`;
  }
  return (
    `${summary.total} finding${summary.total === 1 ? "" : "s"}` +
    ` (${summary.severe} severe, ${summary.moderate} moderate, ${summary.mild} mild)` +
    ` · ${summary.filesRead} file${summary.filesRead === 1 ? "" : "s"} read.`
  );
}

/**
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
 * @param {{ owner: string, repo: string }} repoInfo
 * @param {{ selection?: unknown }} [options]
 */
async function runScan(repoInfo, options = {}) {
  const { owner, repo } = repoInfo;
  if (!owner || !repo) {
    return { ok: false, error: "Missing owner/repo for scan." };
  }

  await ensureGitHubAccess();

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

  if (message.type === "RG_AGENT_HEALTH") {
    fetch(`${AGENT_BASE_URL}/v1/health`)
      .then(async (res) => {
        if (!res.ok) {
          sendResponse({
            ok: false,
            online: false,
            error: `Agent HTTP ${res.status}`,
          });
          return;
        }
        const data = await res.json();
        sendResponse({
          ok: true,
          online: true,
          docker: Boolean(data.docker),
          version: data.version || null,
        });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          online: false,
          error: String(error?.message || error),
        });
      });
    return true;
  }

  if (message.type === "RG_SETUP_DOWNLOAD") {
    const kind = String(message.kind || "helper");
    const platform =
      message.platform && typeof message.platform === "object"
        ? message.platform
        : detectSetupPlatform();

    /** @type {{ ok: boolean, downloads?: object[], opened?: string[], error?: string }} */
    const result = { ok: true, downloads: [], opened: [] };

    const queue = [];

    if (kind === "docker" || kind === "all") {
      const dockerUrl = String(platform.dockerUrl || "");
      const dockerFilename = String(platform.dockerFilename || "");
      if (/docs\.docker\.com/i.test(dockerUrl) || !dockerFilename) {
        queue.push(() =>
          chrome.tabs.create({ url: dockerUrl }).then(() => {
            result.opened.push(dockerUrl);
          }),
        );
      } else {
        queue.push(() =>
          downloadUrl(dockerUrl, dockerFilename).then((id) => {
            result.downloads.push({
              kind: "docker",
              id,
              filename: dockerFilename,
            });
          }),
        );
      }
    }

    if (kind === "node" || kind === "all") {
      const nodeUrl = String(platform.nodeUrl || "https://nodejs.org/en/download");
      queue.push(() =>
        chrome.tabs.create({ url: nodeUrl }).then(() => {
          result.opened.push(nodeUrl);
        }),
      );
    }

    if (kind === "helper" || kind === "all") {
      const helperPath = String(
        platform.helperPath || "bootstrap/Start-RepoGuard-Agent.command",
      );
      const helperName = String(
        platform.helperFilename || "Start-RepoGuard-Agent.command",
      );
      queue.push(() =>
        downloadHelperFile(helperPath, helperName).then((id) => {
          result.downloads.push({ kind: "helper", id, filename: helperName });
        }),
      );
    }

    if (!queue.length) {
      sendResponse({ ok: false, error: "Unknown setup download kind" });
      return false;
    }

    queue
      .reduce((p, fn) => p.then(fn), Promise.resolve())
      .then(() => sendResponse(result))
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message || error),
          downloads: result.downloads,
          opened: result.opened,
        });
      });
    return true;
  }

  if (message.type === "RG_BUILD_CHECK") {
    const owner = String(message.owner || "");
    const repo = String(message.repo || "");
    const ref = message.ref ? String(message.ref) : undefined;
    const body = JSON.stringify({ owner, repo, ...(ref ? { ref } : {}) });

    fetch(`${AGENT_BASE_URL}/v1/build`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({
            ok: false,
            error: data.error || `Agent HTTP ${res.status}`,
          });
          return;
        }
        sendResponse({ ok: true, job: data.job });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error:
            String(error?.message || error) +
            " — is the RepoGuard agent running on 127.0.0.1:3847?",
        });
      });
    return true;
  }

  if (message.type === "RG_BUILD_JOB") {
    const id = String(message.jobId || "");
    if (!id) {
      sendResponse({ ok: false, error: "Missing jobId" });
      return false;
    }
    fetch(`${AGENT_BASE_URL}/v1/jobs/${encodeURIComponent(id)}`)
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          sendResponse({
            ok: false,
            error: data.error || `Agent HTTP ${res.status}`,
          });
          return;
        }
        sendResponse({ ok: true, job: data.job });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: String(error?.message || error),
        });
      });
    return true;
  }

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

    return true;
  }
});
