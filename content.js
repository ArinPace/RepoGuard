/**
 * RepoGuard content script (classic, no ES modules).
 *
 * Floating selection panel (GitHub React wipes in-row DOM). Handles extension
 * reload: old scripts throw "Extension context invalidated" — we detect that,
 * tear down, and allow a fresh inject from the popup.
 */
(function () {
  function isExtensionContextValid() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidatedError(error) {
    const msg = String(error?.message || error || "");
    return msg.includes("Extension context invalidated");
  }

  // After extension reload, a dead script may still be on the page with this flag set.
  if (window.__REPOGUARD_CONTENT__) {
    if (isExtensionContextValid() && window.__REPOGUARD_API__) {
      return; // live instance already running
    }
    try {
      window.__REPOGUARD_API__?.destroy?.();
    } catch {
      /* ignore */
    }
    window.__REPOGUARD_CONTENT__ = false;
    window.__REPOGUARD_API__ = null;
  }
  window.__REPOGUARD_CONTENT__ = true;

  const PANEL_ID = "repoguard-selection-panel";
  const STYLE_ID = "repoguard-content-style";
  const CONTEXT_DEAD_MSG =
    "Extension was reloaded. Refresh this GitHub tab, then click Enable checkboxes again.";

  /** @type {{ owner: string, repo: string } | null} */
  let currentRepo = null;
  let cachedSelection = { files: [], folders: [] };
  let checkboxesEnabled = false;
  let lastHref = location.href;
  let observer = null;
  let refreshTimer = null;
  let destroyed = false;
  let storageListener = null;
  let messageListener = null;
  let popstateListener = null;
  /** @type {"idle" | "scanning" | "ok" | "error"} */
  let scanUiKind = "idle";
  let scanUiText = "";
  let scanBusy = false;
  /** Serialized chrome.storage writes for selection; Scan waits on this. */
  let selectionPersistChain = Promise.resolve();
  let selectionPersistPending = 0;
  /** Bumped on each persist/clear enqueue so superseded jobs can drop. */
  let selectionWriteGen = 0;
  const LAST_SCAN_KEY = "lastScan";
  /** scannedAt of lastScan we already reflected in the panel status */
  let lastSeenScanAt = 0;

  function storageKey(owner, repo) {
    return `selection:${owner}/${repo}`;
  }

  function normalizeFolderPrefix(path) {
    let p = String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
    return p ? `${p}/` : "";
  }

  function normalizeFilePath(path) {
    return String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
  }

  function selectionPickCount(sel) {
    return (sel.files?.length || 0) + (sel.folders?.length || 0);
  }

  function isPathSelected(sel, kind, path) {
    if (kind === "folder") {
      const prefix = normalizeFolderPrefix(path);
      return (sel.folders || []).some((f) => normalizeFolderPrefix(f) === prefix);
    }
    const file = normalizeFilePath(path);
    return (sel.files || []).some((f) => normalizeFilePath(f) === file);
  }

  function togglePathInSelection(sel, kind, path, checked) {
    const next = {
      files: [...(sel.files || [])],
      folders: [...(sel.folders || [])],
    };
    if (kind === "folder") {
      const prefix = normalizeFolderPrefix(path);
      if (!prefix) return next;
      const set = new Set(next.folders.map(normalizeFolderPrefix));
      if (checked) set.add(prefix);
      else set.delete(prefix);
      next.folders = [...set];
    } else {
      const file = normalizeFilePath(path);
      if (!file) return next;
      const set = new Set(next.files.map(normalizeFilePath));
      if (checked) set.add(file);
      else set.delete(file);
      next.files = [...set];
    }
    return next;
  }

  async function getSelection(owner, repo) {
    assertContext();
    const key = storageKey(owner, repo);
    const data = await chrome.storage.local.get(key);
    const raw = data[key];
    if (!raw || typeof raw !== "object") return { files: [], folders: [] };
    return {
      files: Array.isArray(raw.files) ? raw.files.map(normalizeFilePath).filter(Boolean) : [],
      folders: Array.isArray(raw.folders)
        ? raw.folders.map(normalizeFolderPrefix).filter(Boolean)
        : [],
    };
  }

  async function setSelection(owner, repo, next) {
    assertContext();
    const key = storageKey(owner, repo);
    const cleaned = {
      files: [...new Set((next.files || []).map(normalizeFilePath).filter(Boolean))].sort(),
      folders: [
        ...new Set((next.folders || []).map(normalizeFolderPrefix).filter(Boolean)),
      ].sort(),
    };
    await chrome.storage.local.set({ [key]: cleaned });
    return cleaned;
  }

  async function clearSelection(owner, repo) {
    assertContext();
    await chrome.storage.local.remove(storageKey(owner, repo));
    return { files: [], folders: [] };
  }

  function assertContext() {
    if (destroyed || !isExtensionContextValid()) {
      destroy("context_invalidated");
      throw new Error(CONTEXT_DEAD_MSG);
    }
  }

  function destroy(_reason) {
    if (destroyed) return;
    destroyed = true;
    checkboxesEnabled = false;
    stopObserver();
    removePanel();
    try {
      if (messageListener) chrome.runtime.onMessage.removeListener(messageListener);
    } catch {
      /* ignore */
    }
    try {
      if (storageListener) chrome.storage.onChanged.removeListener(storageListener);
    } catch {
      /* ignore */
    }
    if (popstateListener) {
      window.removeEventListener("popstate", popstateListener);
    }
    window.__REPOGUARD_CONTENT__ = false;
    window.__REPOGUARD_API__ = null;
  }

  function parseRepoFromLocation() {
    try {
      const url = new URL(location.href);
      if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
        return null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      const reserved = new Set([
        "settings", "notifications", "marketplace", "explore", "topics",
        "login", "signup", "orgs", "organizations", "search", "pulls", "issues",
      ]);
      if (reserved.has(parts[0].toLowerCase())) return null;
      return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
    } catch {
      return null;
    }
  }

  function isCodeBrowserPage() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return false;
    if (parts.length === 2) return true;
    return parts[2] === "tree";
  }

  function pathFromGitHubHref(href, owner, repo) {
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;
    if (parts[0] !== owner || parts[1] !== repo) return null;
    const kindSeg = parts[2];
    if (kindSeg !== "blob" && kindSeg !== "tree") return null;
    const pathParts = parts.slice(4);
    if (pathParts.length === 0) return null;
    const path = pathParts
      .map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          return p;
        }
      })
      .join("/");
    if (kindSeg === "tree") {
      return { kind: "folder", path: normalizeFilePath(path) };
    }
    return { kind: "file", path: normalizeFilePath(path) };
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        top: 72px;
        right: 16px;
        width: 320px;
        max-height: calc(100vh - 96px);
        z-index: 100000;
        display: flex;
        flex-direction: column;
        border: 1px solid #30363d;
        border-radius: 10px;
        background: #0d1117;
        color: #e6edf3;
        box-shadow: 0 8px 24px rgba(0,0,0,0.45);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
        overflow: hidden;
      }
      #${PANEL_ID} .rg-panel-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 10px 12px;
        border-bottom: 1px solid #30363d;
        background: #161b22;
      }
      #${PANEL_ID} .rg-panel-title {
        font-weight: 700;
        color: #3fb950;
      }
      #${PANEL_ID} .rg-panel-count {
        color: #8b949e;
        font-size: 12px;
      }
      #${PANEL_ID} .rg-panel-actions {
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        justify-content: flex-end;
      }
      #${PANEL_ID} .rg-panel-actions button {
        border: 1px solid #30363d;
        background: #21262d;
        color: #e6edf3;
        border-radius: 6px;
        padding: 4px 8px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
      }
      #${PANEL_ID} .rg-panel-actions button:hover:not(:disabled) {
        background: #30363d;
      }
      #${PANEL_ID} .rg-panel-actions button:disabled {
        opacity: 0.55;
        cursor: not-allowed;
      }
      #${PANEL_ID} .rg-panel-actions button[data-rg-scan] {
        border-color: #238636;
        background: #238636;
        color: #ffffff;
      }
      #${PANEL_ID} .rg-panel-actions button[data-rg-scan]:hover:not(:disabled) {
        background: #2ea043;
        border-color: #2ea043;
      }
      #${PANEL_ID} .rg-panel-actions button[data-rg-scan]:disabled {
        border-color: #30363d;
        background: #21262d;
        color: #8b949e;
        opacity: 1;
      }
      #${PANEL_ID} .rg-panel-hint {
        padding: 8px 12px;
        color: #8b949e;
        font-size: 11px;
        border-bottom: 1px solid #21262d;
        line-height: 1.4;
      }
      #${PANEL_ID} .rg-panel-status {
        padding: 8px 12px;
        font-size: 11px;
        line-height: 1.4;
        border-bottom: 1px solid #21262d;
        color: #8b949e;
      }
      #${PANEL_ID} .rg-panel-status[data-kind="scanning"] {
        color: #58a6ff;
      }
      #${PANEL_ID} .rg-panel-status[data-kind="ok"] {
        color: #3fb950;
      }
      #${PANEL_ID} .rg-panel-status[data-kind="error"] {
        color: #f85149;
      }
      #${PANEL_ID} .rg-panel-list {
        list-style: none;
        margin: 0;
        padding: 6px;
        overflow-y: auto;
        flex: 1;
      }
      #${PANEL_ID} .rg-panel-item {
        display: flex;
        align-items: flex-start;
        gap: 8px;
        padding: 6px 8px;
        border-radius: 6px;
        cursor: pointer;
      }
      #${PANEL_ID} .rg-panel-item:hover {
        background: #161b22;
      }
      #${PANEL_ID} .rg-panel-item input {
        margin-top: 2px;
        width: 15px;
        height: 15px;
        accent-color: #238636;
        flex-shrink: 0;
        cursor: pointer;
      }
      #${PANEL_ID} .rg-panel-item-body {
        min-width: 0;
      }
      #${PANEL_ID} .rg-panel-kind {
        display: block;
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: #8b949e;
      }
      #${PANEL_ID} .rg-panel-item[data-kind="folder"] .rg-panel-kind {
        color: #d29922;
      }
      #${PANEL_ID} .rg-panel-path {
        display: block;
        word-break: break-all;
        color: #e6edf3;
        line-height: 1.35;
      }
      #${PANEL_ID} .rg-panel-empty {
        padding: 16px 12px;
        color: #8b949e;
        font-size: 12px;
        line-height: 1.4;
      }
    `;
    document.documentElement.appendChild(style);
  }

  /**
   * Discover file/folder entries from links currently on the page.
   */
  function discoverEntries(owner, repo) {
    const found = new Map();
    const anchors = document.querySelectorAll(
      `a[href*="/${owner}/${repo}/blob/"], a[href*="/${owner}/${repo}/tree/"]`,
    );

    for (const link of anchors) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      if (link.closest(`#${PANEL_ID}, nav, header, footer, [hidden], template`)) continue;
      if (link.closest(".AppHeader, .UnderlineNav, .js-repo-nav")) continue;
      if (link.closest('[aria-label="Breadcrumb"], [data-testid="breadcrumbs"]')) continue;

      const parsed = pathFromGitHubHref(link.getAttribute("href") || link.href, owner, repo);
      if (!parsed?.path) continue;

      // Prefer links that look like the main file browser (not sidebar noise).
      const inMain =
        link.closest(
          "#repo-content-turbo-frame, #repo-content-pjax-container, [data-hpc], main, [aria-labelledby='folders-and-files'], [role='grid']",
        );
      if (!inMain) continue;

      try {
        const style = window.getComputedStyle(link);
        if (style.display === "none" || style.visibility === "hidden") continue;
      } catch {
        /* ignore */
      }

      const key = `${parsed.kind}:${parsed.path}`;
      if (found.has(key)) continue;
      found.set(key, parsed);
    }

    return [...found.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }

  function removePanel() {
    document.getElementById(PANEL_ID)?.remove();
  }

  function setScanUi(kind, text) {
    scanUiKind = kind;
    scanUiText = text || "";
    const panel = document.getElementById(PANEL_ID);
    if (!panel) return;
    const status = panel.querySelector("[data-rg-status]");
    if (!status) return;
    if (kind === "idle" || !scanUiText) {
      status.hidden = true;
      status.textContent = "";
      status.dataset.kind = "idle";
      return;
    }
    status.hidden = false;
    status.dataset.kind = kind;
    status.textContent = scanUiText;
  }

  function syncScanButtonState(panel) {
    const btn = panel?.querySelector("[data-rg-scan]");
    if (!btn) return;
    const hasSelection = selectionPickCount(cachedSelection) > 0;
    if (scanBusy) {
      btn.disabled = true;
      btn.textContent = "Scanning…";
      return;
    }
    if (selectionPersistPending > 0) {
      btn.disabled = true;
      btn.textContent = "Saving…";
      return;
    }
    btn.textContent = "Scan";
    btn.disabled = !hasSelection;
  }

  /**
   * Queue a durable selection write. Later jobs always persist the latest
   * cachedSelection so rapid toggles don't clobber newer picks with stale ones.
   * Jobs whose generation was superseded by a Clear (or a newer write intent)
   * are dropped so they cannot resurrect cleared picks.
   */
  function queueSelectionPersist(owner, repo) {
    const gen = ++selectionWriteGen;
    selectionPersistPending += 1;
    syncScanButtonState(document.getElementById(PANEL_ID));
    const job = selectionPersistChain.then(async () => {
      assertContext();
      if (gen !== selectionWriteGen) return cachedSelection;
      cachedSelection = await setSelection(owner, repo, cachedSelection);
      return cachedSelection;
    });
    selectionPersistChain = job.catch(() => {
      /* keep chain alive after a failed write */
    }).finally(() => {
      selectionPersistPending = Math.max(0, selectionPersistPending - 1);
      syncScanButtonState(document.getElementById(PANEL_ID));
    });
    return job;
  }

  /**
   * Enqueue Clear on the same persist chain so it cannot race a later toggle's
   * storage write. Supersedes in-flight persist intents via selectionWriteGen.
   */
  function queueSelectionClear(owner, repo) {
    const gen = ++selectionWriteGen;
    cachedSelection = { files: [], folders: [] };
    selectionPersistPending += 1;
    syncScanButtonState(document.getElementById(PANEL_ID));
    const job = selectionPersistChain.then(async () => {
      assertContext();
      // A newer toggle/clear after this enqueue supersedes the clear.
      if (gen !== selectionWriteGen) return cachedSelection;
      await clearSelection(owner, repo);
      if (gen === selectionWriteGen) {
        cachedSelection = { files: [], folders: [] };
      }
      return cachedSelection;
    });
    selectionPersistChain = job.catch(() => {
      /* keep chain alive after a failed clear */
    }).finally(() => {
      selectionPersistPending = Math.max(0, selectionPersistPending - 1);
      syncScanButtonState(document.getElementById(PANEL_ID));
    });
    return job;
  }

  /** Wait for in-flight writes, then flush the current cache once more. */
  async function flushSelection(owner, repo) {
    await selectionPersistChain;
    assertContext();
    const gen = ++selectionWriteGen;
    cachedSelection = await setSelection(owner, repo, cachedSelection);
    // If Clear/toggle raced during the write, prefer the newer in-memory intent.
    if (gen !== selectionWriteGen) return cachedSelection;
    return cachedSelection;
  }

  function formatSummaryMessage(summary) {
    if (!summary || typeof summary !== "object") {
      return "Scan complete. Open the RepoGuard popup for details.";
    }
    if (summary.selectionMatchedNone) {
      return "Selected paths matched no scannable files. Adjust checkboxes and scan again.";
    }
    const total = Number(summary.total) || 0;
    const filesRead = Number(summary.filesRead) || 0;
    if (total === 0) {
      return `No heuristic matches in ${filesRead} file${filesRead === 1 ? "" : "s"}. Open the popup for details.`;
    }
    return (
      `${total} finding${total === 1 ? "" : "s"}` +
      ` (${summary.severe || 0} severe, ${summary.moderate || 0} moderate, ${summary.mild || 0} mild)` +
      ` · ${filesRead} file${filesRead === 1 ? "" : "s"} read. Open RepoGuard popup for details.`
    );
  }

  /**
   * When sendMessage returns undefined (MV3 port closed), read lastScan instead
   * of claiming failure.
   */
  async function readLastScanFallback(owner, repo, startedAt) {
    const data = await chrome.storage.local.get(LAST_SCAN_KEY);
    const last = data[LAST_SCAN_KEY];
    if (!last || typeof last !== "object") return null;
    if (last.owner !== owner || last.repo !== repo) return null;
    const scannedAt = Number(last.scannedAt) || 0;
    if (scannedAt < startedAt) return null;
    lastSeenScanAt = scannedAt;
    return {
      message: formatSummaryMessage(last.summary || last),
      scannedAt,
    };
  }

  function applyLastScanFromStorage(last) {
    if (!last || typeof last !== "object" || !currentRepo) return false;
    if (last.owner !== currentRepo.owner || last.repo !== currentRepo.repo) {
      return false;
    }
    const scannedAt = Number(last.scannedAt) || 0;
    if (scannedAt && scannedAt <= lastSeenScanAt) return false;
    if (scannedAt) lastSeenScanAt = scannedAt;
    setScanUi("ok", formatSummaryMessage(last.summary || last));
    scanBusy = false;
    syncScanButtonState(document.getElementById(PANEL_ID));
    return true;
  }

  async function handlePanelScan(owner, repo) {
    assertContext();
    if (scanBusy) return;
    if (selectionPickCount(cachedSelection) === 0) {
      setScanUi("error", "Select at least one file or folder before scanning.");
      syncScanButtonState(document.getElementById(PANEL_ID));
      return;
    }

    scanBusy = true;
    setScanUi("scanning", "Saving selection, then scanning…");
    syncScanButtonState(document.getElementById(PANEL_ID));

    const startedAt = Date.now();
    try {
      // Durably persist current picks before the worker reads storage / runs.
      const selection = await flushSelection(owner, repo);
      if (selectionPickCount(selection) === 0) {
        setScanUi("error", "Select at least one file or folder before scanning.");
        return;
      }

      setScanUi("scanning", "Scanning selected paths…");

      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: "RG_SCAN",
          owner,
          repo,
          selection,
        });
      } catch (sendError) {
        // Channel error — still check whether the worker finished and wrote lastScan.
        const fallback = await readLastScanFallback(owner, repo, startedAt);
        if (fallback) {
          setScanUi("ok", fallback.message);
          return;
        }
        throw sendError;
      }

      if (response == null) {
        const fallback = await readLastScanFallback(owner, repo, startedAt);
        if (fallback) {
          setScanUi("ok", fallback.message);
          return;
        }
        // Brief delay then retry once — SW may still be writing lastScan.
        await new Promise((r) => setTimeout(r, 250));
        const retry = await readLastScanFallback(owner, repo, startedAt);
        if (retry) {
          setScanUi("ok", retry.message);
          return;
        }
        setScanUi(
          "error",
          "Could not confirm scan status. Open the RepoGuard popup to check results.",
        );
        return;
      }

      if (!response.ok) {
        setScanUi("error", response.error || "Scan failed.");
        return;
      }

      if (response.summary && typeof response.summary === "object") {
        // Align lastSeenScanAt with storage watcher.
        lastSeenScanAt = Math.max(lastSeenScanAt, Number(response.scannedAt) || Date.now());
      }
      setScanUi("ok", response.message || "Scan complete. Open the RepoGuard popup for details.");
    } catch (error) {
      if (isContextInvalidatedError(error) || String(error?.message || "").includes("reloaded")) {
        destroy("context_invalidated");
        window.alert(CONTEXT_DEAD_MSG);
        return;
      }
      setScanUi("error", String(error?.message || error));
    } finally {
      scanBusy = false;
      syncScanButtonState(document.getElementById(PANEL_ID));
    }
  }

  function renderPanel(owner, repo, entries) {
    ensureStyles();
    let panel = document.getElementById(PANEL_ID);
    if (!panel) {
      panel = document.createElement("aside");
      panel.id = PANEL_ID;
      document.body.appendChild(panel);
    }

    const selected = selectionPickCount(cachedSelection);
    panel.innerHTML = `
      <div class="rg-panel-header">
        <div>
          <div class="rg-panel-title">RepoGuard</div>
          <div class="rg-panel-count"><span data-rg-count>${selected}</span> selected</div>
        </div>
        <div class="rg-panel-actions">
          <button type="button" data-rg-scan>Scan</button>
          <button type="button" data-rg-clear>Clear</button>
          <button type="button" data-rg-hide>Hide</button>
        </div>
      </div>
      <div class="rg-panel-hint">
        Tick files/folders here (GitHub’s list re-renders and would wipe in-row boxes). Then Scan — or open the RepoGuard popup for full findings.
      </div>
      <div class="rg-panel-status" data-rg-status data-kind="idle" hidden></div>
      <ul class="rg-panel-list" data-rg-list></ul>
    `;

    setScanUi(scanUiKind, scanUiText);
    syncScanButtonState(panel);

    panel.querySelector("[data-rg-scan]")?.addEventListener("click", (event) => {
      event.preventDefault();
      handlePanelScan(owner, repo).catch((error) => {
        scanBusy = false;
        if (isContextInvalidatedError(error) || String(error?.message || "").includes("reloaded")) {
          destroy("context_invalidated");
          window.alert(CONTEXT_DEAD_MSG);
          return;
        }
        setScanUi("error", String(error?.message || error));
        syncScanButtonState(document.getElementById(PANEL_ID));
      });
    });

    panel.querySelector("[data-rg-clear]")?.addEventListener("click", async (event) => {
      event.preventDefault();
      try {
        // Run Clear through the persist queue so a toggle cannot resurrect picks.
        await queueSelectionClear(owner, repo);
        if (!scanBusy) {
          setScanUi("idle", "");
        }
        renderPanel(owner, repo, entries);
      } catch (error) {
        if (isContextInvalidatedError(error) || String(error?.message || "").includes("reloaded")) {
          destroy("context_invalidated");
          window.alert(CONTEXT_DEAD_MSG);
        }
      }
    });

    panel.querySelector("[data-rg-hide]")?.addEventListener("click", (event) => {
      event.preventDefault();
      hideCheckboxes();
    });

    const list = panel.querySelector("[data-rg-list]");
    if (!list) return;

    if (entries.length === 0) {
      list.outerHTML =
        '<div class="rg-panel-empty">No file/folder links found on this page yet. Wait for GitHub to finish loading, then click Enable checkboxes again.</div>';
      return;
    }

    for (const entry of entries) {
      const li = document.createElement("li");
      li.className = "rg-panel-item";
      li.dataset.kind = entry.kind;

      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = isPathSelected(cachedSelection, entry.kind, entry.path);
      input.addEventListener("click", (event) => event.stopPropagation());
      input.addEventListener("change", () => {
        try {
          cachedSelection = togglePathInSelection(
            cachedSelection,
            entry.kind,
            entry.path,
            input.checked,
          );
          const countEl = panel.querySelector("[data-rg-count]");
          if (countEl) countEl.textContent = String(selectionPickCount(cachedSelection));
          syncScanButtonState(panel);
          queueSelectionPersist(owner, repo).catch((error) => {
            if (isContextInvalidatedError(error) || String(error?.message || "").includes("reloaded")) {
              destroy("context_invalidated");
              window.alert(CONTEXT_DEAD_MSG);
            }
          });
        } catch (error) {
          if (isContextInvalidatedError(error) || String(error?.message || "").includes("reloaded")) {
            destroy("context_invalidated");
            window.alert(CONTEXT_DEAD_MSG);
            return;
          }
          throw error;
        }
      });

      const body = document.createElement("div");
      body.className = "rg-panel-item-body";
      body.innerHTML = `
        <span class="rg-panel-kind">${entry.kind}</span>
        <span class="rg-panel-path"></span>
      `;
      body.querySelector(".rg-panel-path").textContent =
        entry.kind === "folder" ? `${entry.path}/` : entry.path;

      li.addEventListener("click", (event) => {
        if (event.target === input) return;
        input.checked = !input.checked;
        input.dispatchEvent(new Event("change"));
      });

      li.appendChild(input);
      li.appendChild(body);
      list.appendChild(li);
    }
  }

  function syncUi() {
    if (!checkboxesEnabled || !currentRepo || !isCodeBrowserPage()) {
      removePanel();
      return { ok: false, count: 0, reason: "disabled_or_wrong_page" };
    }

    const { owner, repo } = currentRepo;
    const entries = discoverEntries(owner, repo);
    renderPanel(owner, repo, entries);
    return {
      ok: true,
      count: entries.length,
      selected: selectionPickCount(cachedSelection),
    };
  }

  async function enableCheckboxes() {
    assertContext();
    checkboxesEnabled = true;
    if (!isCodeBrowserPage()) {
      return { ok: false, error: "Open a repo code page (not Issues/PRs/a single file)." };
    }
    const parsed = parseRepoFromLocation();
    if (!parsed) {
      return { ok: false, error: "Could not parse owner/repo from this URL." };
    }
    currentRepo = parsed;
    try {
      cachedSelection = await getSelection(parsed.owner, parsed.repo);
    } catch (error) {
      if (isContextInvalidatedError(error) || String(error?.message || "").includes("reloaded")) {
        return { ok: false, error: CONTEXT_DEAD_MSG };
      }
      throw error;
    }
    startObserver();
    const result = syncUi();
    if (result.count === 0) {
      return {
        ok: false,
        error:
          "Panel opened, but no file rows were found yet. Wait for the page to finish loading, then click Enable again.",
      };
    }
    return result;
  }

  function hideCheckboxes() {
    if (!isExtensionContextValid()) {
      destroy("context_invalidated");
      return { ok: false, error: CONTEXT_DEAD_MSG };
    }
    checkboxesEnabled = false;
    stopObserver();
    removePanel();
    return { ok: true };
  }

  function scheduleRefresh() {
    if (!checkboxesEnabled || destroyed) return;
    if (!isExtensionContextValid()) {
      destroy("context_invalidated");
      return;
    }
    // Debounce: GitHub mutates the DOM a lot; don't rebuild every frame.
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      if (!checkboxesEnabled || destroyed) return;
      if (!isExtensionContextValid()) {
        destroy("context_invalidated");
        return;
      }
      const parsed = parseRepoFromLocation();
      if (!parsed || !isCodeBrowserPage()) return;
      currentRepo = parsed;
      // Avoid overwriting in-memory picks with a stale storage snapshot mid-write.
      if (selectionPersistPending > 0 || scanBusy) {
        syncUi();
        return;
      }
      getSelection(parsed.owner, parsed.repo)
        .then((sel) => {
          if (selectionPersistPending > 0 || scanBusy) {
            syncUi();
            return;
          }
          cachedSelection = sel;
          syncUi();
        })
        .catch((error) => {
          if (isContextInvalidatedError(error) || String(error?.message || "").includes("reloaded")) {
            destroy("context_invalidated");
          }
        });
    }, 400);
  }

  function startObserver() {
    if (observer) return;
    observer = new MutationObserver((mutations) => {
      // Ignore mutations inside our own panel (prevents feedback loops).
      for (const m of mutations) {
        const t = m.target;
        if (t instanceof Element && t.closest(`#${PANEL_ID}`)) continue;
        if (t instanceof Element && t.id === PANEL_ID) continue;
        scheduleRefresh();
        return;
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function stopObserver() {
    observer?.disconnect();
    observer = null;
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      refreshTimer = null;
    }
  }

  messageListener = (message, _sender, sendResponse) => {
    if (destroyed || !message || typeof message !== "object") return;

    if (!isExtensionContextValid()) {
      destroy("context_invalidated");
      sendResponse({ ok: false, error: CONTEXT_DEAD_MSG });
      return false;
    }

    if (message.type === "RG_ENABLE_CHECKBOXES") {
      enableCheckboxes()
        .then(sendResponse)
        .catch((error) =>
          sendResponse({
            ok: false,
            error: isContextInvalidatedError(error)
              ? CONTEXT_DEAD_MSG
              : String(error?.message || error),
          }),
        );
      return true;
    }

    if (message.type === "RG_HIDE_CHECKBOXES") {
      sendResponse(hideCheckboxes());
      return false;
    }

    if (message.type === "RG_FLUSH_SELECTION") {
      const parsed = currentRepo || parseRepoFromLocation();
      if (!parsed) {
        sendResponse({ ok: true, selection: { files: [], folders: [] } });
        return false;
      }
      flushSelection(parsed.owner, parsed.repo)
        .then((selection) => sendResponse({ ok: true, selection }))
        .catch((error) =>
          sendResponse({
            ok: false,
            error: isContextInvalidatedError(error)
              ? CONTEXT_DEAD_MSG
              : String(error?.message || error),
          }),
        );
      return true;
    }

    if (message.type === "RG_CHECKBOX_STATUS") {
      sendResponse({
        ok: true,
        enabled: checkboxesEnabled,
        onCodePage: isCodeBrowserPage(),
        selected: selectionPickCount(cachedSelection),
      });
      return false;
    }
  };
  chrome.runtime.onMessage.addListener(messageListener);

  storageListener = (changes, area) => {
    if (destroyed || !isExtensionContextValid()) {
      destroy("context_invalidated");
      return;
    }
    if (area !== "local") return;

    if (changes[LAST_SCAN_KEY] && currentRepo) {
      applyLastScanFromStorage(changes[LAST_SCAN_KEY].newValue);
    }

    if (!currentRepo || !checkboxesEnabled) return;
    const key = storageKey(currentRepo.owner, currentRepo.repo);
    if (!changes[key]) return;
    // Don't clobber newer local picks while our own write is still in flight.
    if (selectionPersistPending > 0 || scanBusy) return;
    const next = changes[key].newValue;
    cachedSelection = next
      ? {
          files: Array.isArray(next.files) ? next.files : [],
          folders: Array.isArray(next.folders) ? next.folders : [],
        }
      : { files: [], folders: [] };
    syncUi();
  };
  chrome.storage.onChanged.addListener(storageListener);

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    origPush.apply(this, args);
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (checkboxesEnabled && !destroyed) scheduleRefresh();
    }
  };
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (checkboxesEnabled && !destroyed) scheduleRefresh();
    }
  };
  popstateListener = () => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      if (checkboxesEnabled && !destroyed) scheduleRefresh();
    }
  };
  window.addEventListener("popstate", popstateListener);

  window.__REPOGUARD_API__ = {
    destroy,
    enableCheckboxes,
    hideCheckboxes,
  };
})();
