# RepoGuard

Chrome extension that scans public GitHub repositories with **local heuristic rules** (regex patterns) and explains why each match matters and how to fix it.

## Current status

**Chunk 8 — Scan from the selection panel.** The floating GitHub panel has a primary **Scan** button (disabled until something is selected). Scans run in a background service worker so the popup does not need to stay open; open the popup afterward for full finding details.

## How to use selection

1. Open a repo code page (`github.com/owner/repo` or `.../tree/branch/...`)
2. Open RepoGuard → click **Enable checkboxes**
3. Use the **floating panel on the right** of the GitHub page (GitHub’s own file list re-renders and would wipe in-row boxes)
4. Tick files/folders → **Scan** enables when something is selected (panel or popup)
5. After a panel scan, the panel shows a short finding summary; open the RepoGuard popup for full results
6. **Hide checkboxes** (popup or panel) removes the panel; selection is kept until Clear

Selection is stored in `chrome.storage.local` (shared by the popup, background worker, and page script). Use **Clear** on the panel to reset.

## Reload after this change

On `chrome://extensions`, click **Reload** on RepoGuard (accept new permissions for `storage` and `github.com` if prompted). Then **refresh** any open GitHub tabs so the content script picks up the panel Scan button.

### Permissions

- `activeTab` — read the current tab URL when you open the popup  
- `storage` — session selection memory + last scan results  
- `api.github.com` / `raw.githubusercontent.com` — fetch file lists and contents  
- `github.com` — content script checkboxes on the code browser  

## Rate limits

Unauthenticated GitHub API access is roughly **60 requests/hour**. Each scan uses a few API calls plus raw file downloads. Public repos only in this version.

## Load locally (unpacked)

1. Open Chrome → `chrome://extensions`
2. Developer mode → **Load unpacked** → this folder
3. Open a GitHub repo → Enable checkboxes → select paths → **Scan** on the panel (or in the popup)

## Pack a zip

```bash
cd /Users/arainajain/Desktop/RepoGuard
zip -r ../RepoGuard.zip manifest.json popup.html popup.css popup.js background.js github.js githubApi.js languages.js findings.js rules.js scanner.js selection.js content.js content.css icons
```

## Project layout

```
RepoGuard/
  manifest.json
  background.js      # MV3 service worker (panel Scan)
  popup.html/css/js
  content.js/css     # Selection panel on GitHub pages
  selection.js       # Session selection helpers
  github.js          # Parse owner/repo URLs
  githubApi.js       # GitHub API + raw fetch
  languages.js       # Scannable extensions
  rules.js           # Heuristic rules
  scanner.js         # Fetch → filter by selection → rules
  findings.js
  icons/
```

### Languages scanned

See [`languages.js`](languages.js) for the extension list (JS/TS, Python, JVM, Go, Rust, C/C++, shells, configs, templates, …).
