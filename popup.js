import { parseGitHubRepoUrl, formatRepoLabel } from "./github.js";
import { scannableExtensionList } from "./githubApi.js";
import {
  scanRepository,
  locationToGitHubUrl,
  countBySeverity,
} from "./findings.js";
import {
  getSelection,
  selectionIsEmpty,
  selectionPickCount,
  selectionStorageKey,
} from "./selection.js";

/** Shared with background.js — last successful scan for popup details. */
const LAST_SCAN_KEY = "lastScan";

/** @type {{ owner: string, repo: string, pathname: string } | null} */
let currentRepo = null;

/** @type {import("./selection.js").RepoSelection} */
let currentSelection = { files: [], folders: [] };

/** @type {import("./findings.js").Finding[]} */
let currentFindings = [];

/** @type {string} */
let currentDefaultBranch = "main";

/** @type {string | null} */
let selectedFindingId = null;
/** @type {{ file: string, line: number } | null} */
let selectedLocation = null;
let locationsExpanded = false;

/** @type {"severe" | "moderate" | "mild" | null} */
let openSeverity = null;

/** Whether Scan is allowed for reasons other than selection (busy, not a repo). */
let scanContextOk = false;

const SEVERITY_LABELS = {
  severe: "Severe",
  moderate: "Moderate",
  mild: "Mild",
};

const SEVERITY_ORDER = ["severe", "moderate", "mild"];

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0] ?? null;
}

function setScanEnabled(enabled) {
  scanContextOk = enabled;
  syncScanButton();
}

function syncScanButton() {
  const btn = document.getElementById("scanBtn");
  if (!btn) return;
  const hasSelection = !selectionIsEmpty(currentSelection);
  const allow = scanContextOk && Boolean(currentRepo) && hasSelection;
  btn.disabled = !allow;
  if (!btn.dataset.busy) {
    btn.textContent = "Scan repository";
  }
}

function setScanBusy(busy) {
  const btn = document.getElementById("scanBtn");
  if (busy) {
    btn.dataset.busy = "1";
    btn.disabled = true;
    btn.textContent = "Scanning…";
  } else {
    delete btn.dataset.busy;
    syncScanButton();
  }
}

function selectionDetailLine() {
  const n = selectionPickCount(currentSelection);
  if (n === 0) {
    return "Click Enable checkboxes, use the RepoGuard panel on the right of the GitHub page, then Scan (panel or popup).";
  }
  const files = currentSelection.files.length;
  const folders = currentSelection.folders.length;
  return `${n} selected this session (${files} file${files === 1 ? "" : "s"}, ${folders} folder${folders === 1 ? "" : "s"}). Scan only includes those paths.`;
}

function setCheckboxActionsVisible(visible) {
  const el = document.getElementById("checkboxActions");
  if (el) el.hidden = !visible;
}

/**
 * Talk to the content script on the active GitHub tab.
 * If it is not loaded yet, inject content.js via chrome.scripting then retry.
 */
async function sendCheckboxMessage(type) {
  const tab = await getActiveTab();
  if (!tab?.id) {
    throw new Error("No active tab.");
  }
  if (!tab.url || !tab.url.includes("github.com")) {
    throw new Error("Switch to a GitHub repository tab first.");
  }

  async function once() {
    return chrome.tabs.sendMessage(tab.id, { type });
  }

  try {
    return await once();
  } catch (error) {
    const msg = String(error?.message || error || "");
    // No receiver, or orphaned content script after extension reload.
    const needsInject =
      msg.includes("Receiving end does not exist") ||
      msg.includes("Could not establish connection") ||
      msg.includes("Extension context invalidated");

    if (!needsInject) throw error;

    // Clear stale flag + inject a fresh content script, then retry.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        try {
          window.__REPOGUARD_API__?.destroy?.();
        } catch {
          /* ignore */
        }
        window.__REPOGUARD_CONTENT__ = false;
        window.__REPOGUARD_API__ = null;
      },
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"],
    });
    await new Promise((r) => setTimeout(r, 80));
    return once();
  }
}

async function handleEnableCheckboxes() {
  const detailEl = document.getElementById("detail");
  try {
    const result = await sendCheckboxMessage("RG_ENABLE_CHECKBOXES");
    if (!result?.ok) {
      detailEl.textContent =
        result?.error ||
        "Could not show checkboxes. Reload the GitHub page, then try Enable again.";
      return;
    }
    await refreshSelectionFromStorage();
    detailEl.textContent = `Selection panel on (${result.count} items). Tick boxes in the panel on the right, then Scan there or here. ${selectionDetailLine()}`;
  } catch (error) {
    detailEl.textContent = String(error?.message || error);
  }
}

async function handleHideCheckboxes() {
  const detailEl = document.getElementById("detail");
  try {
    await sendCheckboxMessage("RG_HIDE_CHECKBOXES");
    detailEl.textContent = `Checkboxes hidden. Selection is kept for this session. ${selectionDetailLine()}`;
  } catch (error) {
    detailEl.textContent = String(error?.message || error);
  }
}

/** @type {"repo" | "results" | "other"} */
let uiKind = "other";

function renderState({ kind, title, detail }) {
  const status = document.getElementById("status");
  const detailEl = document.getElementById("detail");
  const badge = document.getElementById("badge");

  status.textContent = title;
  detailEl.textContent = detail;

  const labels = {
    repo: "Repo detected",
    scanning: "Scanning",
    results: "Scan complete",
  };
  badge.textContent = labels[kind] ?? "Not a repo";
  badge.dataset.kind = kind === "scanning" || kind === "results" ? "repo" : kind;

  if (kind === "repo" || kind === "results") uiKind = kind;
  else if (kind !== "scanning") uiKind = "other";

  setCheckboxActionsVisible(kind === "repo" || kind === "results");

  // Only repo / results contexts can scan — still gated by selection.
  setScanEnabled(kind === "repo" || kind === "results");
}

/** Move notes out of the finding list so re-renders don't destroy the node. */
function parkNotes() {
  const notes = document.getElementById("notes");
  const park = document.getElementById("notesPark");
  if (!notes || !park) return;
  notes.setAttribute("hidden", "");
  park.appendChild(notes);
}

function clearResults() {
  currentFindings = [];
  selectedFindingId = null;
  selectedLocation = null;
  locationsExpanded = false;
  openSeverity = null;
  currentDefaultBranch = "main";
  parkNotes();
  document.getElementById("results").hidden = true;
  document.getElementById("severityGroups").innerHTML = "";
  syncExportButton();
}

function syncExportButton() {
  const btn = document.getElementById("exportBtn");
  if (!btn) return;
  const has = currentFindings.length > 0;
  btn.disabled = !has;
  if (btn.dataset.copied !== "1") {
    btn.textContent = "Export findings";
  }
}

/**
 * @param {import("./findings.js").Finding[]} findings
 */
function formatFindingsExport(findings) {
  const repoLabel = currentRepo ? formatRepoLabel(currentRepo) : "unknown repo";
  const branch = currentDefaultBranch || "main";
  const counts = countBySeverity(findings);
  const lines = [
    `RepoGuard findings — ${repoLabel}`,
    `Branch: ${branch}`,
    `Total: ${findings.length} (${counts.severe} severe, ${counts.moderate} moderate, ${counts.mild} mild)`,
    "",
  ];

  const order = ["severe", "moderate", "mild"];
  for (const severity of order) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${severity.toUpperCase()} (${group.length})`);
    lines.push("");
    for (const finding of group) {
      const locs = finding.locations?.length
        ? finding.locations
        : [{ file: finding.file, line: finding.line }];
      lines.push(`[${finding.severity}] ${finding.title}`);
      if (finding.ruleId) lines.push(`Rule: ${finding.ruleId}`);
      lines.push("Locations:");
      for (const loc of locs) {
        const url =
          currentRepo != null
            ? locationToGitHubUrl(currentRepo, loc, branch)
            : `${loc.file}:${loc.line}`;
        lines.push(`  - ${loc.file}:${loc.line}`);
        if (currentRepo) lines.push(`    ${url}`);
      }
      lines.push(`Why: ${finding.why || ""}`);
      lines.push(`Fix: ${finding.fix || ""}`);
      lines.push("");
    }
  }

  return lines.join("\n").trim() + "\n";
}

async function handleExportFindings() {
  const btn = document.getElementById("exportBtn");
  if (!currentFindings.length) return;

  const text = formatFindingsExport(currentFindings);
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      btn.dataset.copied = "1";
      btn.textContent = "Copied!";
      window.setTimeout(() => {
        btn.dataset.copied = "0";
        btn.textContent = "Export findings";
        syncExportButton();
      }, 1500);
    }
  } catch (error) {
    if (btn) {
      btn.textContent = "Copy failed";
      window.setTimeout(() => {
        btn.textContent = "Export findings";
        syncExportButton();
      }, 1500);
    }
    document.getElementById("detail").textContent = String(
      error?.message || error || "Could not copy findings to the clipboard.",
    );
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function findingLocations(finding) {
  if (finding.locations?.length) return finding.locations;
  return [{ file: finding.file, line: finding.line }];
}

function locationLabel(loc) {
  return `${loc.file}:${loc.line}`;
}

function formatFindingLoc(finding) {
  const locs = findingLocations(finding);
  if (locs.length === 1) return locationLabel(locs[0]);
  return `${locs.length} locations`;
}

function renderLocationPanel(finding) {
  const locs = findingLocations(finding);
  const summary = document.getElementById("notesLocation");
  const list = document.getElementById("notesLocList");
  const chevron = document.getElementById("notesLocChevron");
  const toggle = document.getElementById("notesLocToggle");

  if (locs.length === 1) {
    summary.textContent = locationLabel(locs[0]);
    summary.hidden = false;
    list.hidden = true;
    list.innerHTML = "";
    locationsExpanded = false;
    chevron.textContent = "";
    toggle.setAttribute("aria-expanded", "false");
    toggle.disabled = true;
    return;
  }

  toggle.disabled = false;
  chevron.textContent = locationsExpanded ? "▼" : "▶";
  toggle.setAttribute("aria-expanded", String(locationsExpanded));

  if (!locationsExpanded) {
    summary.hidden = false;
    summary.textContent = `${locs.length} locations — click Location to expand`;
    list.hidden = true;
    list.innerHTML = "";
    return;
  }

  summary.hidden = true;
  list.hidden = false;
  list.innerHTML = "";
  for (const loc of locs) {
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "notes-loc-item";
    btn.textContent = locationLabel(loc);
    btn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectedLocation = loc;
      if (!currentRepo) return;
      const url = locationToGitHubUrl(currentRepo, loc, currentDefaultBranch);
      await chrome.tabs.create({ url });
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function selectFinding(id) {
  selectedFindingId = id;
  const finding = currentFindings.find((item) => item.id === id);
  if (!finding) return;

  const locs = findingLocations(finding);
  selectedLocation = locs[0];
  locationsExpanded = false;

  for (const button of document.querySelectorAll(".finding")) {
    button.classList.toggle("is-selected", button.dataset.findingId === id);
  }

  const notes = document.getElementById("notes");
  notes.removeAttribute("hidden");
  document.getElementById("notesTitle").textContent = finding.title || "";
  const n = locs.length;
  document.getElementById("notesMeta").textContent =
    `${finding.severity || ""}${n > 1 ? ` · ${n} locations` : ""}`;
  document.getElementById("notesWhy").textContent =
    finding.why || "(No explanation for this rule.)";
  document.getElementById("notesFix").textContent =
    finding.fix || "(No fix notes for this rule.)";
  renderLocationPanel(finding);

  const selectedBtn = document.querySelector(
    `.finding[data-finding-id="${CSS.escape(id)}"]`,
  );
  const row = selectedBtn?.closest(".finding-row");
  if (row) {
    row.appendChild(notes);
    notes.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

function toggleLocations() {
  if (!selectedFindingId) return;
  const finding = currentFindings.find((item) => item.id === selectedFindingId);
  if (!finding) return;
  const locs = findingLocations(finding);
  if (locs.length <= 1) return;
  locationsExpanded = !locationsExpanded;
  renderLocationPanel(finding);
}

function findingsBySeverity(findings) {
  /** @type {Record<string, import("./findings.js").Finding[]>} */
  const groups = { severe: [], moderate: [], mild: [] };
  for (const finding of findings) {
    groups[finding.severity].push(finding);
  }
  return groups;
}

function defaultOpenSeverity(counts) {
  for (const severity of SEVERITY_ORDER) {
    if (counts[severity] > 0) return severity;
  }
  return null;
}

function setOpenSeverity(severity) {
  const next = openSeverity === severity ? null : severity;
  if (next !== openSeverity) {
    parkNotes();
    selectedFindingId = null;
    selectedLocation = null;
    locationsExpanded = false;
  }
  openSeverity = next;

  for (const group of document.querySelectorAll(".severity-group")) {
    const isOpen = group.dataset.severity === openSeverity;
    group.classList.toggle("is-open", isOpen);
    const chevron = group.querySelector(".severity-chevron");
    if (chevron) chevron.textContent = isOpen ? "▼" : "▶";
    const toggle = group.querySelector(".severity-toggle");
    if (toggle) toggle.setAttribute("aria-expanded", String(isOpen));
  }
}

function renderSeverityGroups(findings) {
  parkNotes();
  const container = document.getElementById("severityGroups");
  container.innerHTML = "";

  const groups = findingsBySeverity(findings);
  const counts = countBySeverity(findings);

  if (findings.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty-results";
    empty.textContent =
      "No heuristic matches in the scanned files. That does not mean the repo is safe — only that these rules did not fire.";
    container.appendChild(empty);
    return;
  }

  for (const severity of SEVERITY_ORDER) {
    const list = groups[severity];
    if (list.length === 0) continue;

    const group = document.createElement("div");
    group.className = "severity-group";
    group.dataset.severity = severity;

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "severity-toggle";
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = `
      <span class="severity-label">${SEVERITY_LABELS[severity]}</span>
      <span class="severity-meta">
        <span>${list.length}</span>
        <span class="severity-chevron">▶</span>
      </span>
    `;
    toggle.addEventListener("click", () => setOpenSeverity(severity));

    const ul = document.createElement("ul");
    ul.className = "finding-list";

    for (const finding of list) {
      const li = document.createElement("li");
      li.className = "finding-row";

      const button = document.createElement("button");
      button.type = "button";
      button.className = "finding";
      button.dataset.findingId = finding.id;
      button.dataset.severity = finding.severity;
      button.innerHTML = `
        <span class="finding-title">${escapeHtml(finding.title)}</span>
        <span class="finding-loc">${escapeHtml(formatFindingLoc(finding))}</span>
      `;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        selectFinding(finding.id);
      });

      li.appendChild(button);
      ul.appendChild(li);
    }

    group.appendChild(toggle);
    group.appendChild(ul);
    container.appendChild(group);
  }

  openSeverity = null;
  const initial = defaultOpenSeverity(counts);
  if (initial) setOpenSeverity(initial);
}

function describeScanStats(result) {
  if (result.selectionMatchedNone) {
    return "Selected paths matched no scannable files (wrong types, empty folder, or not in the fetched tree). Adjust checkboxes and scan again.";
  }

  if (result.treeBlobCount === 0) {
    return "GitHub returned an empty file tree (empty repo, or the default branch has no files).";
  }

  if (result.filesAvailable === 0) {
    return (
      `Found ${result.treeBlobCount} file(s) in the repo, but none matched scannable types ` +
      `(${scannableExtensionList()}). Example: a README-only repo scans 0 files. ` +
      "Try a repo with JavaScript/Python/etc."
    );
  }

  if (result.filesRead === 0 && result.filesScanned > 0) {
    return (
      `Found ${result.filesAvailable} eligible file(s) but could not download contents. ` +
      "Check Site access for raw.githubusercontent.com on chrome://extensions → RepoGuard → Details."
    );
  }

  const capNote = result.capped
    ? `Read ${result.filesRead} of ${result.filesAvailable} eligible files (capped at ${result.filesScanned}).`
    : `Read ${result.filesRead} file${result.filesRead === 1 ? "" : "s"}.`;

  const truncNote = result.truncated
    ? " GitHub’s full file list was too large, so RepoGuard scanned a partial tree."
    : "";

  const selNote = result.selectionFiltered ? " (filtered to your selection)." : "";

  if (result.findings.length === 0) {
    return `No heuristic matches. ${capNote}${selNote}${truncNote} That does not mean the repo is safe.`;
  }

  return `Click a finding to see why/fix under it. ${capNote}${selNote}${truncNote}`;
}

function showScanResult(result) {
  currentFindings = result.findings;
  currentDefaultBranch = result.defaultBranch;
  selectedFindingId = null;
  selectedLocation = null;
  locationsExpanded = false;

  const results = document.getElementById("results");
  results.hidden = false;
  parkNotes();

  renderSeverityGroups(result.findings);
  syncExportButton();

  renderState({
    kind: "results",
    title: formatRepoLabel(currentRepo),
    detail: `${describeScanStats(result)} ${selectionDetailLine()}`,
  });
}

/**
 * Persist findings so a panel-triggered scan (or popup scan) can be reviewed later.
 * @param {import("./scanner.js").ScanResult} result
 */
async function storeLastScan(result) {
  if (!currentRepo) return;
  const counts = countBySeverity(result.findings);
  await chrome.storage.local.set({
    [LAST_SCAN_KEY]: {
      owner: currentRepo.owner,
      repo: currentRepo.repo,
      scannedAt: Date.now(),
      summary: {
        owner: currentRepo.owner,
        repo: currentRepo.repo,
        total: result.findings.length,
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
      },
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
 * @returns {Promise<boolean>} true if restored
 */
async function tryRestoreLastScan() {
  if (!currentRepo) return false;
  const data = await chrome.storage.local.get(LAST_SCAN_KEY);
  const last = data[LAST_SCAN_KEY];
  if (!last || typeof last !== "object") return false;
  if (last.owner !== currentRepo.owner || last.repo !== currentRepo.repo) {
    return false;
  }
  if (!Array.isArray(last.findings)) return false;

  showScanResult({
    findings: last.findings,
    defaultBranch: last.defaultBranch || "main",
    filesRead: last.filesRead ?? 0,
    filesAvailable: last.filesAvailable ?? 0,
    filesScanned: last.filesScanned ?? 0,
    treeBlobCount: last.treeBlobCount ?? 0,
    capped: Boolean(last.capped),
    truncated: Boolean(last.truncated),
    selectionFiltered: Boolean(last.selectionFiltered),
    selectionMatchedNone: Boolean(last.selectionMatchedNone),
  });
  return true;
}

async function refreshSelectionFromStorage() {
  if (!currentRepo) {
    currentSelection = { files: [], folders: [] };
    syncScanButton();
    return;
  }
  currentSelection = await getSelection(currentRepo.owner, currentRepo.repo);
  syncScanButton();
}

async function handleScan() {
  if (!currentRepo) return;
  if (selectionIsEmpty(currentSelection)) {
    renderState({
      kind: "repo",
      title: formatRepoLabel(currentRepo),
      detail: selectionDetailLine(),
    });
    return;
  }

  clearResults();
  setScanBusy(true);
  renderState({
    kind: "scanning",
    title: formatRepoLabel(currentRepo),
    detail: "Checking GitHub access, then fetching selected files…",
  });

  try {
    await ensureGitHubAccess();
    const result = await scanRepository(currentRepo, {
      selection: currentSelection,
    });
    await storeLastScan(result);
    showScanResult(result);
  } catch (error) {
    renderState({
      kind: "error",
      title: "Scan failed",
      detail: String(error?.message || error),
    });
  } finally {
    setScanBusy(false);
  }
}

async function handleOpenOnGitHub() {
  if (!currentRepo || !selectedFindingId) return;
  const finding = currentFindings.find((item) => item.id === selectedFindingId);
  if (!finding) return;

  const loc =
    selectedLocation ||
    findingLocations(finding)[0] ||
    { file: finding.file, line: finding.line };
  const url = locationToGitHubUrl(currentRepo, loc, currentDefaultBranch);
  await chrome.tabs.create({ url });
}

async function detectActivePage() {
  clearResults();
  currentRepo = null;
  currentSelection = { files: [], folders: [] };
  setScanEnabled(false);

  const tab = await getActiveTab();
  const url = tab?.url;

  if (!url) {
    renderState({
      kind: "blocked",
      title: "Can't read this tab",
      detail:
        "Chrome hides some page URLs (settings, Web Store, new tab). Open a normal https://github.com/... page and try again.",
    });
    return;
  }

  const repo = parseGitHubRepoUrl(url);

  if (repo) {
    currentRepo = repo;
    await refreshSelectionFromStorage();
    const restored = await tryRestoreLastScan();
    if (restored) return;
    renderState({
      kind: "repo",
      title: formatRepoLabel(repo),
      detail: selectionDetailLine(),
    });
    return;
  }

  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    host = null;
  }

  if (host === "github.com" || host === "www.github.com") {
    renderState({
      kind: "github",
      title: "GitHub, but not a repo",
      detail:
        "You're on GitHub, but this URL isn't owner/repo (e.g. a profile, search, or settings page).",
    });
    return;
  }

  renderState({
    kind: "other",
    title: "Not on GitHub",
    detail: "Open a repository like github.com/owner/repo, then click RepoGuard again.",
  });
}

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("scanBtn").addEventListener("click", () => {
    handleScan().catch((error) => {
      renderState({
        kind: "error",
        title: "Scan failed",
        detail: String(error?.message || error),
      });
      setScanBusy(false);
    });
  });

  document.getElementById("enableChecksBtn").addEventListener("click", () => {
    handleEnableCheckboxes().catch((error) => {
      document.getElementById("detail").textContent = String(
        error?.message || error,
      );
    });
  });

  document.getElementById("hideChecksBtn").addEventListener("click", () => {
    handleHideCheckboxes().catch((error) => {
      document.getElementById("detail").textContent = String(
        error?.message || error,
      );
    });
  });

  document.getElementById("openBtn").addEventListener("click", () => {
    handleOpenOnGitHub().catch(() => {
      /* ignore — popup may close when opening a tab */
    });
  });

  document.getElementById("exportBtn").addEventListener("click", () => {
    handleExportFindings().catch(() => {
      /* clipboard / focus edge cases */
    });
  });

  document.getElementById("notesLocToggle").addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggleLocations();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !currentRepo) return;

    if (changes[LAST_SCAN_KEY]) {
      const last = changes[LAST_SCAN_KEY].newValue;
      if (
        last &&
        typeof last === "object" &&
        last.owner === currentRepo.owner &&
        last.repo === currentRepo.repo &&
        Array.isArray(last.findings)
      ) {
        showScanResult({
          findings: last.findings,
          defaultBranch: last.defaultBranch || "main",
          filesRead: last.filesRead ?? 0,
          filesAvailable: last.filesAvailable ?? 0,
          filesScanned: last.filesScanned ?? 0,
          treeBlobCount: last.treeBlobCount ?? 0,
          capped: Boolean(last.capped),
          truncated: Boolean(last.truncated),
          selectionFiltered: Boolean(last.selectionFiltered),
          selectionMatchedNone: Boolean(last.selectionMatchedNone),
        });
      }
    }

    const key = selectionStorageKey(currentRepo.owner, currentRepo.repo);
    if (!changes[key]) return;
    refreshSelectionFromStorage().then(() => {
      if (uiKind !== "repo" && uiKind !== "results") return;
      renderState({
        kind: uiKind,
        title: formatRepoLabel(currentRepo),
        detail:
          uiKind === "results"
            ? `Selection updated. ${selectionDetailLine()}`
            : selectionDetailLine(),
      });
    });
  });

  detectActivePage().catch((error) => {
    renderState({
      kind: "error",
      title: "Detection failed",
      detail: String(error?.message || error),
    });
  });
});
