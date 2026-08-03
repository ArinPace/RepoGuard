/**
 * Selection for which files/folders to scan.
 * Uses chrome.storage.local (content scripts cannot use storage.session —
 * that throws "Access to storage is not allowed from this context").
 * Keyed per owner/repo.
 *
 * @typedef {object} RepoSelection
 * @property {string[]} files   - exact repo-relative paths
 * @property {string[]} folders - prefixes with trailing slash, e.g. "src/"
 */

/** Shared storage area usable from side panel + content script. */
export const selectionStore = chrome.storage.local;

export function emptySelection() {
  return { files: [], folders: [] };
}

export function selectionStorageKey(owner, repo) {
  return `selection:${owner}/${repo}`;
}

export function normalizeFolderPrefix(path) {
  let p = String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!p) return "";
  return `${p}/`;
}

export function normalizeFilePath(path) {
  return String(path || "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * @param {RepoSelection | null | undefined} sel
 */
export function selectionIsEmpty(sel) {
  if (!sel) return true;
  return (sel.files?.length ?? 0) === 0 && (sel.folders?.length ?? 0) === 0;
}

/**
 * Count of discrete user picks (files + folders), not expanded file count.
 * @param {RepoSelection | null | undefined} sel
 */
export function selectionPickCount(sel) {
  if (!sel) return 0;
  return (sel.files?.length ?? 0) + (sel.folders?.length ?? 0);
}

/**
 * @param {string} filePath
 * @param {RepoSelection | null | undefined} sel
 */
export function pathMatchesSelection(filePath, sel) {
  if (selectionIsEmpty(sel)) return false;
  const path = normalizeFilePath(filePath);
  if (sel.files.some((f) => normalizeFilePath(f) === path)) return true;
  return sel.folders.some((folder) => {
    const prefix = normalizeFolderPrefix(folder);
    return prefix && path.startsWith(prefix);
  });
}

/**
 * @param {string} owner
 * @param {string} repo
 * @returns {Promise<RepoSelection>}
 */
export async function getSelection(owner, repo) {
  const key = selectionStorageKey(owner, repo);
  const data = await selectionStore.get(key);
  const raw = data[key];
  if (!raw || typeof raw !== "object") return emptySelection();
  return {
    files: Array.isArray(raw.files) ? raw.files.map(normalizeFilePath).filter(Boolean) : [],
    folders: Array.isArray(raw.folders)
      ? raw.folders.map(normalizeFolderPrefix).filter(Boolean)
      : [],
  };
}

/**
 * @param {string} owner
 * @param {string} repo
 * @param {RepoSelection} next
 */
export async function setSelection(owner, repo, next) {
  const key = selectionStorageKey(owner, repo);
  const cleaned = {
    files: [...new Set((next.files || []).map(normalizeFilePath).filter(Boolean))].sort(),
    folders: [
      ...new Set((next.folders || []).map(normalizeFolderPrefix).filter(Boolean)),
    ].sort(),
  };
  await selectionStore.set({ [key]: cleaned });
  return cleaned;
}

/**
 * @param {string} owner
 * @param {string} repo
 */
export async function clearSelection(owner, repo) {
  const key = selectionStorageKey(owner, repo);
  await selectionStore.remove(key);
  return emptySelection();
}

/**
 * Toggle a file or folder in the selection.
 * @param {RepoSelection} sel
 * @param {"file" | "folder"} kind
 * @param {string} path
 * @param {boolean} checked
 * @returns {RepoSelection}
 */
export function togglePathInSelection(sel, kind, path, checked) {
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

/**
 * Whether a path is currently selected (exact file or exact folder prefix).
 * @param {RepoSelection} sel
 * @param {"file" | "folder"} kind
 * @param {string} path
 */
export function isPathSelected(sel, kind, path) {
  if (kind === "folder") {
    const prefix = normalizeFolderPrefix(path);
    return sel.folders.some((f) => normalizeFolderPrefix(f) === prefix);
  }
  const file = normalizeFilePath(path);
  return sel.files.some((f) => normalizeFilePath(f) === file);
}
