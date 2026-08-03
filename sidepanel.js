import { parseGitHubRepoUrl, formatRepoLabel } from "./github.js";
import { ensureGitHubAccess, scannableExtensionList } from "./githubApi.js";
import {
  locationToGitHubUrl,
  countBySeverity,
} from "./findings.js";
import {
  getSelection,
  setSelection,
  clearSelection,
  selectionIsEmpty,
  selectionPickCount,
  selectionStorageKey,
  togglePathInSelection,
  isPathSelected,
} from "./selection.js";

const LAST_SCAN_KEY = "lastScan";

/** @type {{ owner: string, repo: string, pathname?: string } | null} */
let currentRepo = null;

/** @type {import("./selection.js").RepoSelection} */
let currentSelection = { files: [], folders: [] };

/** @type {{ kind: "file" | "folder", path: string }[]} */
let listedEntries = [];

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

let scanContextOk = false;
let selectionPersistChain = Promise.resolve();

/** @type {"repo" | "results" | "other"} */
let uiKind = "other";

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
    btn.textContent = "Scan selection";
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

function syncSelectMeta() {
  const meta = document.getElementById("selectMeta");
  if (!meta) return;
  const n = selectionPickCount(currentSelection);
  const files = currentSelection.files.length;
  const folders = currentSelection.folders.length;
  meta.textContent =
    n === 0
      ? "0 selected — tick files or folders below"
      : `${n} selected (${files} file${files === 1 ? "" : "s"}, ${folders} folder${folders === 1 ? "" : "s"})`;
}

function selectionDetailLine() {
  const n = selectionPickCount(currentSelection);
  if (n === 0) {
    return "Select files or folders in the list below, then Scan.";
  }
  return `Scan will include ${n} selected path${n === 1 ? "" : "s"}.`;
}

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
  badge.dataset.kind =
    kind === "scanning" || kind === "results" ? "repo" : kind;

  if (kind === "repo" || kind === "results") uiKind = kind;
  else if (kind !== "scanning") uiKind = "other";

  const selectSection = document.getElementById("selectSection");
  if (selectSection) {
    selectSection.hidden = !(kind === "repo" || kind === "results");
  }

  setScanEnabled(kind === "repo" || kind === "results");
}

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
  document.getElementById("severityGroups").replaceChildren();
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

  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(`## ${severity.toUpperCase()} (${group.length})`);
    lines.push("");
    for (const finding of group) {
      const locs = findingLocations(finding);
      lines.push(`[${finding.severity}] ${finding.title}`);
      if (finding.ruleId) lines.push(`Rule: ${finding.ruleId}`);
      lines.push("Locations:");
      for (const loc of locs) {
        lines.push(`  - ${loc.file}:${loc.line}`);
        if (currentRepo) {
          lines.push(`    ${locationToGitHubUrl(currentRepo, loc, branch)}`);
        }
      }
      lines.push(`Why: ${finding.why || ""}`);
      lines.push(`Fix: ${finding.fix || ""}`);
      lines.push("");
    }
  }

  return `${lines.join("\n").trim()}\n`;
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
      error?.message || error || "Could not copy findings.",
    );
  }
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
    list.replaceChildren();
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
    list.replaceChildren();
    return;
  }

  summary.hidden = true;
  list.hidden = false;
  list.replaceChildren();
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
  container.replaceChildren();

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

    const label = document.createElement("span");
    label.className = "severity-label";
    label.textContent = SEVERITY_LABELS[severity];

    const meta = document.createElement("span");
    meta.className = "severity-meta";
    const countSpan = document.createElement("span");
    countSpan.textContent = String(list.length);
    const chevron = document.createElement("span");
    chevron.className = "severity-chevron";
    chevron.textContent = "▶";
    meta.append(countSpan, chevron);
    toggle.append(label, meta);
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
      const title = document.createElement("span");
      title.className = "finding-title";
      title.textContent = finding.title;
      const loc = document.createElement("span");
      loc.className = "finding-loc";
      loc.textContent = formatFindingLoc(finding);
      button.append(title, loc);
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
    return "Selected paths matched no scannable files. Adjust selection and scan again.";
  }
  if (result.treeBlobCount === 0) {
    return "GitHub returned an empty file tree.";
  }
  if (result.filesAvailable === 0) {
    return `No scannable types in selection (${scannableExtensionList()}).`;
  }
  if (result.filesRead === 0 && result.filesScanned > 0) {
    return "Could not download file contents. Check Site access on chrome://extensions → RepoGuard.";
  }
  const capNote = result.capped
    ? `Read ${result.filesRead} of ${result.filesAvailable} eligible files (capped).`
    : `Read ${result.filesRead} file${result.filesRead === 1 ? "" : "s"}.`;
  const truncNote = result.truncated
    ? " Tree was truncated by GitHub."
    : "";
  const selNote = result.selectionFiltered ? " Filtered to selection." : "";
  if (result.findings.length === 0) {
    return `No heuristic matches. ${capNote}${selNote}${truncNote}`;
  }
  return `Click a finding for details. ${capNote}${selNote}${truncNote}`;
}

function showScanResult(result) {
  currentFindings = result.findings;
  currentDefaultBranch = result.defaultBranch;
  selectedFindingId = null;
  selectedLocation = null;
  locationsExpanded = false;

  document.getElementById("results").hidden = false;
  parkNotes();
  renderSeverityGroups(result.findings);
  syncExportButton();

  renderState({
    kind: "results",
    title: formatRepoLabel(currentRepo),
    detail: `${describeScanStats(result)} ${selectionDetailLine()}`,
  });
}

function renderSelectList() {
  const list = document.getElementById("selectList");
  const empty = document.getElementById("selectEmpty");
  list.replaceChildren();

  if (listedEntries.length === 0) {
    empty.hidden = false;
    syncSelectMeta();
    return;
  }
  empty.hidden = true;

  for (const entry of listedEntries) {
    const li = document.createElement("li");
    li.className = "select-item";
    li.dataset.kind = entry.kind;

    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = isPathSelected(currentSelection, entry.kind, entry.path);

    const body = document.createElement("div");
    body.className = "select-item-body";
    const kind = document.createElement("span");
    kind.className = "select-kind";
    kind.textContent = entry.kind;
    const path = document.createElement("span");
    path.className = "select-path";
    path.textContent =
      entry.kind === "folder" ? `${entry.path}/` : entry.path;
    body.append(kind, path);

    const applyChange = () => {
      if (!currentRepo) return;
      currentSelection = togglePathInSelection(
        currentSelection,
        entry.kind,
        entry.path,
        input.checked,
      );
      syncSelectMeta();
      syncScanButton();
      queuePersistSelection();
      if (uiKind === "repo" || uiKind === "results") {
        document.getElementById("detail").textContent = selectionDetailLine();
      }
    };

    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("change", applyChange);
    li.addEventListener("click", (event) => {
      if (event.target === input) return;
      input.checked = !input.checked;
      applyChange();
    });

    li.append(input, body);
    list.appendChild(li);
  }
  syncSelectMeta();
}

function queuePersistSelection() {
  if (!currentRepo) return selectionPersistChain;
  const owner = currentRepo.owner;
  const repo = currentRepo.repo;
  const snapshot = {
    files: [...currentSelection.files],
    folders: [...currentSelection.folders],
  };
  selectionPersistChain = selectionPersistChain
    .then(() => setSelection(owner, repo, snapshot))
    .catch(() => {
      /* keep chain alive */
    });
  return selectionPersistChain;
}

/**
 * Message the active GitHub tab's content script; inject if needed.
 */
async function sendTabMessage(message) {
  const tab = await getActiveTab();
  if (!tab?.id) throw new Error("No active tab.");
  if (!tab.url || !tab.url.includes("github.com")) {
    throw new Error("Switch to a GitHub repository tab first.");
  }

  async function once() {
    return chrome.tabs.sendMessage(tab.id, message);
  }

  try {
    return await once();
  } catch (error) {
    const msg = String(error?.message || error || "");
    const needsInject =
      msg.includes("Receiving end does not exist") ||
      msg.includes("Could not establish connection") ||
      msg.includes("Extension context invalidated");
    if (!needsInject) throw error;

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

async function refreshEntryList() {
  const empty = document.getElementById("selectEmpty");
  try {
    const result = await sendTabMessage({ type: "RG_LIST_ENTRIES" });
    if (!result?.ok) {
      listedEntries = [];
      renderSelectList();
      if (empty) {
        empty.hidden = false;
        empty.textContent =
          result?.error ||
          "Could not read files from this page. Open a repo code view and Refresh.";
      }
      return result;
    }
    listedEntries = Array.isArray(result.entries) ? result.entries : [];
    renderSelectList();
    return result;
  } catch (error) {
    listedEntries = [];
    renderSelectList();
    if (empty) {
      empty.hidden = false;
      empty.textContent = String(error?.message || error);
    }
    return null;
  }
}

async function refreshSelectionFromStorage() {
  if (!currentRepo) {
    currentSelection = { files: [], folders: [] };
    syncScanButton();
    syncSelectMeta();
    return;
  }
  currentSelection = await getSelection(currentRepo.owner, currentRepo.repo);
  syncScanButton();
  renderSelectList();
}

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
    detail: "Saving selection, then scanning…",
  });

  try {
    await selectionPersistChain;
    await setSelection(
      currentRepo.owner,
      currentRepo.repo,
      currentSelection,
    );

    const response = await chrome.runtime.sendMessage({
      type: "RG_SCAN",
      owner: currentRepo.owner,
      repo: currentRepo.repo,
      selection: currentSelection,
    });

    if (!response?.ok) {
      throw new Error(response?.error || "Scan failed.");
    }

    const data = await chrome.storage.local.get(LAST_SCAN_KEY);
    const last = data[LAST_SCAN_KEY];
    if (
      last &&
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
    } else {
      renderState({
        kind: "results",
        title: formatRepoLabel(currentRepo),
        detail: response.message || "Scan complete.",
      });
    }
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

async function handleClearSelection() {
  if (!currentRepo) return;
  await selectionPersistChain;
  currentSelection = await clearSelection(currentRepo.owner, currentRepo.repo);
  renderSelectList();
  syncScanButton();
  document.getElementById("detail").textContent = selectionDetailLine();
}

async function detectActivePage() {
  clearResults();
  currentRepo = null;
  currentSelection = { files: [], folders: [] };
  listedEntries = [];
  setScanEnabled(false);
  document.getElementById("selectSection").hidden = true;
  renderSelectList();

  const tab = await getActiveTab();
  const url = tab?.url;

  if (!url) {
    renderState({
      kind: "blocked",
      title: "Can't read this tab",
      detail:
        "Chrome hides some page URLs. Open a normal https://github.com/... tab.",
    });
    return;
  }

  const repo = parseGitHubRepoUrl(url);
  if (repo) {
    currentRepo = repo;
    await refreshSelectionFromStorage();
    await refreshEntryList();
    const restored = await tryRestoreLastScan();
    if (restored) {
      document.getElementById("selectSection").hidden = false;
      return;
    }
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
        "Open a repository like github.com/owner/repo (code browser), then use this panel.",
    });
    return;
  }

  renderState({
    kind: "other",
    title: "Not on GitHub",
    detail: "Open a GitHub repository, then click the RepoGuard icon again.",
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

  document.getElementById("refreshListBtn").addEventListener("click", () => {
    refreshEntryList().catch((error) => {
      document.getElementById("detail").textContent = String(
        error?.message || error,
      );
    });
  });

  document.getElementById("clearSelBtn").addEventListener("click", () => {
    handleClearSelection().catch((error) => {
      document.getElementById("detail").textContent = String(
        error?.message || error,
      );
    });
  });

  document.getElementById("exportBtn").addEventListener("click", () => {
    handleExportFindings().catch(() => {});
  });

  document.getElementById("openBtn").addEventListener("click", () => {
    handleOpenOnGitHub().catch(() => {});
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
      document.getElementById("detail").textContent = selectionDetailLine();
    });
  });

  chrome.tabs.onActivated.addListener(() => {
    detectActivePage().catch(() => {});
  });

  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (info.status !== "complete" && !info.url) return;
    chrome.tabs.query({ active: true, currentWindow: true }).then((tabs) => {
      if (tabs[0]?.id === tabId) {
        detectActivePage().catch(() => {});
      }
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
