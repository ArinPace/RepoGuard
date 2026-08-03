# RepoGuard

Chrome extension that scans public GitHub repositories with **local heuristic rules** (regex patterns) and explains why each match matters and how to fix it.

## Current status

**Side panel UI.** Click the RepoGuard toolbar icon to open a docked side panel. Select files/folders from the list (read from the active GitHub tab), scan, and review findings — all in one place. The panel is enabled only on `github.com` tabs and auto-hides when you switch away or leave GitHub.

## How to use

1. Open a repo code page (`github.com/owner/repo` or `.../tree/branch/...`)
2. Click the **RepoGuard** icon in the Chrome toolbar → the **side panel** opens
3. Tick files/folders in **Select paths** (use **Refresh** if the list is empty after navigation)
4. Click **Scan selection**
5. Review findings in the panel; use **Export findings** to copy results

Selection is stored in `chrome.storage.local` per owner/repo.

## Reload after this change

On `chrome://extensions`, click **Reload** on RepoGuard (accept `sidePanel` if prompted). Refresh any open GitHub tabs so the content script updates.

### Permissions

- `activeTab` / `scripting` — read the active tab and list paths on GitHub  
- `storage` — selection + last scan  
- `sidePanel` — docked extension UI  
- `api.github.com` / `raw.githubusercontent.com` — fetch trees and file contents  
- `github.com` — content script path discovery  

## Rate limits

Unauthenticated GitHub API access is roughly **60 requests/hour**. Each scan uses a few API calls plus raw file downloads. Public repos only in this version.

## Load locally (unpacked)

1. Open Chrome → `chrome://extensions`
2. Developer mode → **Load unpacked** → this folder
3. Open a GitHub repo → click RepoGuard → select paths → **Scan selection**

## Pack a zip

```bash
cd /Users/arainajain/Desktop/RepoGuard
zip -r ../RepoGuard.zip manifest.json sidepanel.html sidepanel.css sidepanel.js background.js github.js githubApi.js languages.js findings.js rules.js scanner.js selection.js content.js icons
```

## Project layout

```
RepoGuard/
  manifest.json
  sidepanel.html/css/js   # Docked UI (select + scan + findings)
  background.js           # Side panel behavior + RG_SCAN worker
  content.js              # Path discovery on GitHub pages
  selection.js
  github.js / githubApi.js
  languages.js / rules.js / scanner.js / findings.js
  icons/
  tests/
```

### Languages scanned

See [`languages.js`](languages.js) for the extension list (JS/TS, Python, JVM, Go, Rust, C/C++, shells, configs, templates, …).
