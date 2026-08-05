import { parseGitHubRepoUrl, formatRepoLabel, refFromRepoPathname } from "./github.js";
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

/** @type {ReturnType<typeof setInterval> | null} */
let agentHealthTimer = null;
/** @type {ReturnType<typeof setInterval> | null} */
let buildPollTimer = null;
let buildBusy = false;
let agentOnline = false;

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

  const buildSection = document.getElementById("buildSection");
  if (buildSection) {
    buildSection.hidden = !(kind === "repo" || kind === "results");
  }

  setScanEnabled(kind === "repo" || kind === "results");
  syncBuildButton();
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

async function handleSelectAll() {
  if (!currentRepo || listedEntries.length === 0) return;
  await selectionPersistChain;
  let next = {
    files: [...(currentSelection.files || [])],
    folders: [...(currentSelection.folders || [])],
  };
  for (const entry of listedEntries) {
    next = togglePathInSelection(next, entry.kind, entry.path, true);
  }
  currentSelection = await setSelection(
    currentRepo.owner,
    currentRepo.repo,
    next,
  );
  renderSelectList();
  syncScanButton();
  document.getElementById("detail").textContent = selectionDetailLine();
}

async function handleClearSelection() {
  if (!currentRepo) return;
  await selectionPersistChain;
  currentSelection = await clearSelection(currentRepo.owner, currentRepo.repo);
  renderSelectList();
  syncScanButton();
  document.getElementById("detail").textContent = selectionDetailLine();
}

function syncBuildButton() {
  const btn = document.getElementById("buildBtn");
  if (!btn) return;
  const allow =
    !buildBusy && Boolean(currentRepo) && (uiKind === "repo" || uiKind === "results");
  btn.disabled = !allow;
  if (!buildBusy) {
    btn.textContent = "Test production";
  }
}

/**
 * @param {"unknown" | "online" | "offline" | "nodocker"} state
 * @param {string} label
 */
function setAgentPill(state, label) {
  const pill = document.getElementById("agentPill");
  if (!pill) return;
  pill.dataset.state = state;
  pill.textContent = label;
}

/** @type {((value: boolean) => void) | null} */
let setupWaitResolve = null;

const SETUP_PROGRESS_KEY = "setupProgress";

/** @type {{
 *   dockerDownloadedAt?: number,
 *   dockerDownloadId?: number,
 *   nodeOpenedAt?: number,
 *   helperDownloadedAt?: number,
 *   helperDownloadId?: number,
 * }} */
let setupProgress = {};

/** @type {boolean} */
let agentDockerReady = false;

function getSetupPlatform() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const isMac = /Mac/i.test(ua) || /Mac/i.test(platform);
  const isWin = /Win/i.test(ua) || /Win/i.test(platform);
  const archArm = true;

  if (isMac) {
    return {
      os: "mac",
      dockerUrl: archArm
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

async function loadSetupProgress() {
  try {
    const data = await chrome.storage.local.get(SETUP_PROGRESS_KEY);
    setupProgress =
      data[SETUP_PROGRESS_KEY] && typeof data[SETUP_PROGRESS_KEY] === "object"
        ? data[SETUP_PROGRESS_KEY]
        : {};
  } catch {
    setupProgress = {};
  }
  syncSetupButtons();
  renderSetupChecklist();
}

async function saveSetupProgress(patch) {
  setupProgress = { ...setupProgress, ...patch };
  await chrome.storage.local.set({ [SETUP_PROGRESS_KEY]: setupProgress });
  syncSetupButtons();
  renderSetupChecklist();
}

function showSetupModal() {
  const overlay = document.getElementById("setupOverlay");
  if (overlay) overlay.hidden = false;
  syncSetupButtons();
  renderSetupChecklist();
}

function hideSetupModal(cancel = true) {
  const overlay = document.getElementById("setupOverlay");
  if (overlay) overlay.hidden = true;
  if (cancel && setupWaitResolve) {
    const resolve = setupWaitResolve;
    setupWaitResolve = null;
    resolve(false);
  }
}

/**
 * @param {string} key
 * @param {"todo" | "done" | "busy" | "warn"} state
 * @param {string} [label]
 */
function setChecklistItem(key, state, label) {
  const item = document.querySelector(`#setupChecklist [data-key="${key}"]`);
  if (!item) return;
  item.dataset.state = state;
  const mark = item.querySelector(".setup-check-mark");
  if (mark) {
    mark.textContent =
      state === "done" ? "✓" : state === "busy" ? "…" : state === "warn" ? "!" : "○";
  }
  if (label) {
    const text = item.querySelector("span:last-child");
    if (text) text.textContent = label;
  }
}

function renderSetupChecklist() {
  setChecklistItem(
    "dockerDownloaded",
    setupProgress.dockerDownloadedAt ? "done" : "todo",
    setupProgress.dockerDownloadedAt
      ? "Docker installer downloaded"
      : "Docker installer not downloaded yet",
  );
  setChecklistItem(
    "nodeOpened",
    setupProgress.nodeOpenedAt ? "done" : "todo",
    setupProgress.nodeOpenedAt
      ? "Node.js download page opened"
      : "Node.js download page not opened yet",
  );
  setChecklistItem(
    "helperDownloaded",
    setupProgress.helperDownloadedAt ? "done" : "todo",
    setupProgress.helperDownloadedAt
      ? "RepoGuard helper downloaded"
      : "RepoGuard helper not downloaded yet",
  );

  if (agentOnline) {
    setChecklistItem("helperOnline", "done", "Helper running");
    if (agentDockerReady) {
      setChecklistItem("dockerReady", "done", "Docker daemon ready");
    } else {
      setChecklistItem(
        "dockerReady",
        "warn",
        "Helper is up — open Docker Desktop and wait until it is ready",
      );
    }
  } else {
    setChecklistItem(
      "helperOnline",
      setupProgress.helperDownloadedAt ? "busy" : "todo",
      setupProgress.helperDownloadedAt
        ? "Waiting for helper — Right‑click → Open the .command file"
        : "Helper not running yet",
    );
    setChecklistItem("dockerReady", "todo", "Docker daemon not checked yet");
  }

  const reveal = document.getElementById("setupRevealBtn");
  if (reveal) {
    reveal.hidden = !setupProgress.helperDownloadId;
  }
}

function syncSetupButtons() {
  const dockerBtn = document.getElementById("setupDockerBtn");
  const nodeBtn = document.getElementById("setupNodeBtn");
  const helperBtn = document.getElementById("setupHelperBtn");
  if (dockerBtn) {
    dockerBtn.textContent = setupProgress.dockerDownloadedAt
      ? "Download again"
      : "Download";
  }
  if (nodeBtn) {
    nodeBtn.textContent = setupProgress.nodeOpenedAt ? "Open again" : "Download";
  }
  if (helperBtn) {
    helperBtn.textContent = setupProgress.helperDownloadedAt
      ? "Download again"
      : "Download";
  }
}

/**
 * @param {"docker" | "node" | "helper" | "missing"} kind
 */
async function requestSetupDownload(kind) {
  const note = document.getElementById("setupNote");
  await loadSetupProgress();

  /** @type {Array<"docker" | "node" | "helper">} */
  let kinds = [];
  if (kind === "missing") {
    if (!setupProgress.dockerDownloadedAt) kinds.push("docker");
    if (!setupProgress.nodeOpenedAt) kinds.push("node");
    if (!setupProgress.helperDownloadedAt) kinds.push("helper");
    if (!kinds.length) {
      if (note) {
        note.textContent =
          "Nothing missing to download. Install Docker + Node if needed, then Right‑click → Open the helper.";
      }
      return { ok: true, skipped: true };
    }
  } else {
    kinds = [kind];
  }

  try {
    for (const item of kinds) {
      // Skip docker re-download unless user explicitly chose "Download again"
      if (
        item === "docker" &&
        kind === "missing" &&
        setupProgress.dockerDownloadedAt
      ) {
        continue;
      }

      const response = await chrome.runtime.sendMessage({
        type: "RG_SETUP_DOWNLOAD",
        kind: item,
        platform: getSetupPlatform(),
      });
      if (!response?.ok) {
        throw new Error(response?.error || `Download failed (${item})`);
      }

      if (item === "docker") {
        const id = response.downloads?.find((d) => d.kind === "docker")?.id;
        await saveSetupProgress({
          dockerDownloadedAt: Date.now(),
          ...(id ? { dockerDownloadId: id } : {}),
        });
      } else if (item === "node") {
        await saveSetupProgress({ nodeOpenedAt: Date.now() });
      } else if (item === "helper") {
        const id = response.downloads?.find((d) => d.kind === "helper")?.id;
        await saveSetupProgress({
          helperDownloadedAt: Date.now(),
          ...(id ? { helperDownloadId: id } : {}),
        });
      }
    }

    if (note) {
      if (kind === "helper" || kinds.includes("helper")) {
        note.textContent =
          "Helper ready in Downloads. If Mac blocks it: Right‑click → Open → Open (not Move to Bin).";
      } else if (kind === "docker") {
        note.textContent =
          "Docker installer downloaded. Open the .dmg, install, then start Docker Desktop.";
      } else if (kind === "node") {
        note.textContent =
          "Opened the Node.js page. Install the LTS .pkg, then download/open the helper.";
      } else {
        note.textContent =
          "Missing downloads started. Install them, then Right‑click → Open the helper.";
      }
    }
    renderSetupChecklist();
    return { ok: true };
  } catch (error) {
    if (note) note.textContent = String(error?.message || error);
    throw error;
  }
}

/**
 * Show setup popup and wait until helper is online with Docker ready, or user cancels.
 * @param {{ timeoutMs?: number }} [opts]
 */
async function ensureAgentReady(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
  await loadSetupProgress();
  await refreshAgentHealth();
  if (agentOnline && agentDockerReady) return true;

  setBuildStatus("Setup needed — download only what you still need…", "busy");
  showSetupModal();
  // Do NOT auto-download. User clicks buttons explicitly.

  const started = Date.now();
  return new Promise((resolve) => {
    setupWaitResolve = resolve;

    const tick = async () => {
      if (!setupWaitResolve) return;
      await refreshAgentHealth();
      renderSetupChecklist();

      if (agentOnline && agentDockerReady) {
        const done = setupWaitResolve;
        setupWaitResolve = null;
        hideSetupModal(false);
        setBuildStatus("Helper ready — starting production test…", "busy");
        done(true);
        return;
      }

      if (Date.now() - started >= timeoutMs) {
        const done = setupWaitResolve;
        setupWaitResolve = null;
        hideSetupModal(false);
        done(false);
        return;
      }

      const left = Math.ceil((timeoutMs - (Date.now() - started)) / 1000);
      if (agentOnline && !agentDockerReady) {
        setBuildStatus(`Helper online — waiting for Docker Desktop… (${left}s)`, "busy");
      } else {
        setBuildStatus(`Waiting for helper… (${left}s)`, "busy");
      }
      setTimeout(tick, 2000);
    };

    tick();
  });
}

async function refreshAgentHealth() {
  try {
    const response = await chrome.runtime.sendMessage({ type: "RG_AGENT_HEALTH" });
    if (response?.online) {
      agentOnline = true;
      agentDockerReady = response.docker !== false;
      if (!agentDockerReady) {
        setAgentPill("nodocker", "No Docker");
        const hint = document.getElementById("buildHint");
        if (hint) {
          hint.textContent =
            "Helper is up but Docker isn’t. Open Docker Desktop, then click Test production.";
        }
      } else {
        setAgentPill("online", "Ready");
        const hint = document.getElementById("buildHint");
        if (hint) {
          hint.textContent =
            "One click clones the repo, downloads the toolchain image, installs deps, and builds in Docker.";
        }
      }
    } else {
      agentOnline = false;
      agentDockerReady = false;
      setAgentPill("offline", "Setup needed");
      const hint = document.getElementById("buildHint");
      if (hint) {
        hint.textContent =
          "Click Test production — a popup tracks setup and only downloads when you ask.";
      }
    }
  } catch {
    agentOnline = false;
    agentDockerReady = false;
    setAgentPill("offline", "Setup needed");
  }
  syncBuildButton();
  renderSetupChecklist();
}

function stopBuildPoll() {
  if (buildPollTimer) {
    clearInterval(buildPollTimer);
    buildPollTimer = null;
  }
}

/**
 * @param {string} text
 * @param {"ok" | "fail" | "warn" | "busy"} kind
 */
function setBuildStatus(text, kind) {
  const statusEl = document.getElementById("buildStatus");
  if (!statusEl) return;
  statusEl.hidden = false;
  statusEl.dataset.kind = kind;
  statusEl.textContent = text;
}

/**
 * @param {object} job
 */
function renderBuildJob(job) {
  const statusEl = document.getElementById("buildStatus");
  const logEl = document.getElementById("buildLog");
  if (!statusEl || !logEl) return;

  statusEl.hidden = false;
  logEl.hidden = false;

  if (job.status === "done" || job.status === "error") {
    const result = job.result || {};
    if (result.unsupported) {
      statusEl.dataset.kind = "warn";
      statusEl.textContent = result.error || "Unsupported stack";
    } else if (result.ok) {
      statusEl.dataset.kind = "ok";
      const secs = result.durationMs
        ? ` in ${(result.durationMs / 1000).toFixed(1)}s`
        : "";
      statusEl.textContent = `Production build passed (${result.stack || "unknown"})${secs}`;
    } else {
      statusEl.dataset.kind = "fail";
      statusEl.textContent =
        result.error || job.error || `Build failed (exit ${result.exitCode})`;
    }
  } else {
    statusEl.dataset.kind = "busy";
    const phase = job.phase || job.status;
    const labels = {
      queued: "Queued…",
      cloning: "Downloading repository…",
      detecting: "Detecting stack…",
      downloading: "Downloading toolchain image…",
      building: "Installing deps + building…",
    };
    statusEl.textContent = labels[phase] || `Running (${phase})…`;
  }

  const logText = job.result?.logTail || job.log || "";
  logEl.textContent = logText || "(no log yet)";
}

async function pollBuildJob(jobId) {
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: "RG_BUILD_JOB",
          jobId,
        });
        if (!response?.ok || !response.job) {
          throw new Error(response?.error || "Lost build job");
        }
        renderBuildJob(response.job);
        if (response.job.status === "done" || response.job.status === "error") {
          stopBuildPoll();
          resolve(response.job);
        }
      } catch (error) {
        stopBuildPoll();
        reject(error);
      }
    };

    buildPollTimer = setInterval(poll, 2000);
    poll();
  });
}

async function handleBuildCheck() {
  if (!currentRepo || buildBusy) return;
  buildBusy = true;
  stopBuildPoll();
  syncBuildButton();
  const btn = document.getElementById("buildBtn");
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Testing…";
  }

  const logEl = document.getElementById("buildLog");
  if (logEl) {
    logEl.hidden = false;
    logEl.textContent = "";
  }
  setBuildStatus("Starting production test…", "busy");

  try {
    const ready = await ensureAgentReady();
    if (!ready) {
      throw new Error(
        "Helper did not come online in time. Use the download popup, install Docker + Node, double-click the helper, then click Test production again.",
      );
    }

    const health = await chrome.runtime.sendMessage({ type: "RG_AGENT_HEALTH" });
    if (health?.online && health.docker === false) {
      throw new Error(
        "Docker is not running. Open Docker Desktop, wait until it is ready, then click Test production again.",
      );
    }

    const ref = refFromRepoPathname(currentRepo.pathname) || undefined;
    const started = await chrome.runtime.sendMessage({
      type: "RG_BUILD_CHECK",
      owner: currentRepo.owner,
      repo: currentRepo.repo,
      ref,
    });
    if (!started?.ok || !started.job?.id) {
      throw new Error(started?.error || "Failed to start production test");
    }

    renderBuildJob(started.job);
    await pollBuildJob(started.job.id);
  } catch (error) {
    setBuildStatus(String(error?.message || error), "fail");
  } finally {
    buildBusy = false;
    stopBuildPoll();
    syncBuildButton();
  }
}

async function detectActivePage() {
  clearResults();
  currentRepo = null;
  currentSelection = { files: [], folders: [] };
  listedEntries = [];
  setScanEnabled(false);
  stopBuildPoll();
  buildBusy = false;
  document.getElementById("selectSection").hidden = true;
  const buildSection = document.getElementById("buildSection");
  if (buildSection) buildSection.hidden = true;
  syncBuildButton();
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

  document.getElementById("selectAllBtn").addEventListener("click", () => {
    handleSelectAll().catch((error) => {
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

  document.getElementById("buildBtn").addEventListener("click", () => {
    handleBuildCheck().catch((error) => {
      const statusEl = document.getElementById("buildStatus");
      if (statusEl) {
        statusEl.hidden = false;
        statusEl.dataset.kind = "fail";
        statusEl.textContent = String(error?.message || error);
      }
      buildBusy = false;
      stopBuildPoll();
      syncBuildButton();
    });
  });

  document.getElementById("setupDockerBtn").addEventListener("click", () => {
    requestSetupDownload("docker").catch(() => {});
  });
  document.getElementById("setupNodeBtn").addEventListener("click", () => {
    requestSetupDownload("node").catch(() => {});
  });
  document.getElementById("setupHelperBtn").addEventListener("click", () => {
    requestSetupDownload("helper").catch(() => {});
  });
  document.getElementById("setupAllBtn").addEventListener("click", () => {
    requestSetupDownload("missing").catch(() => {});
  });
  document.getElementById("setupRevealBtn").addEventListener("click", () => {
    const id = setupProgress.helperDownloadId;
    if (!id) return;
    chrome.runtime
      .sendMessage({ type: "RG_SHOW_DOWNLOAD", downloadId: id })
      .catch(() => {});
  });
  document.getElementById("setupCloseBtn").addEventListener("click", () => {
    hideSetupModal(true);
  });
  document.getElementById("setupCancelBtn").addEventListener("click", () => {
    hideSetupModal(true);
  });
  document.getElementById("setupContinueBtn").addEventListener("click", () => {
    refreshAgentHealth()
      .then(() => {
        const note = document.getElementById("setupNote");
        if (agentOnline && agentDockerReady && setupWaitResolve) {
          const done = setupWaitResolve;
          setupWaitResolve = null;
          hideSetupModal(false);
          setBuildStatus("Helper ready — starting production test…", "busy");
          done(true);
          return;
        }
        if (agentOnline && !agentDockerReady) {
          if (note) {
            note.textContent =
              "Helper is running, but Docker isn’t ready yet. Open Docker Desktop and wait for it to start.";
          }
          return;
        }
        if (note) {
          note.textContent =
            "Helper not detected yet. After installs: Finder → Right‑click the helper → Open → Open.";
        }
      })
      .catch(() => {});
  });

  loadSetupProgress().catch(() => {});
  refreshAgentHealth().catch(() => {});
  agentHealthTimer = setInterval(() => {
    refreshAgentHealth().catch(() => {});
  }, 5000);

  detectActivePage().catch((error) => {
    renderState({
      kind: "error",
      title: "Detection failed",
      detail: String(error?.message || error),
    });
  });
});
