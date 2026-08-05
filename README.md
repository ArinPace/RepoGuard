# RepoGuard

Chrome extension that scans public GitHub repositories with **local heuristic rules** (regex patterns) and explains why each match matters and how to fix it. Optionally verifies whether a repo **installs and builds** via a local Docker agent.

## Current status

**Side panel UI.** Click the RepoGuard toolbar icon to open a docked side panel. Select files/folders, run a heuristic scan, and optionally **Check build** (local Docker). The panel is enabled only on `github.com` tabs and auto-hides when you switch away or leave GitHub.

## How to use

1. Open a repo code page (`github.com/owner/repo` or `.../tree/branch/...`)
2. Click the **RepoGuard** icon in the Chrome toolbar → the **side panel** opens
3. Tick files/folders in **Select paths** (use **Refresh** / **Select all** as needed)
4. Click **Scan selection** for heuristic findings
5. (Optional) Start the local agent, then click **Check build**

Selection is stored in `chrome.storage.local` per owner/repo.

## Local build check (Docker agent)

Click **Test production** in the side panel. That clones the public repo, pulls the toolchain Docker image, installs dependencies, and runs the build.

Chrome cannot start Docker by itself. **First time only**, clicking **Test production** opens a **Download requirements** popup with buttons for:

1. **Docker Desktop** (installer download)
2. **Node.js** (download page)
3. **RepoGuard helper** (starter script)

Or use **Download all**. Install the apps, double-click the helper, and the panel continues when the helper is online.

### Requirements (once)

- [Docker Desktop](https://www.docker.com/products/docker-desktop/)
- Node.js 18+
- `git`

### Manual agent start (optional)

```bash
cd agent
npm start
```

- `GET /v1/health` — agent + Docker status  
- `POST /v1/build` — `{ "owner", "repo", "ref?" }` → job  
- `GET /v1/jobs/:id` — poll status / logs / result  

Supported stacks (first match): Node (`package.json`), Rust (`Cargo.toml`), Go (`go.mod`), Python (`pyproject.toml` / `requirements.txt`), Make (`Makefile` with `build`). Unknown stacks return a clear unsupported result (not a crash).

Jobs time out after **10 minutes**. Log tails are capped (~256KB). Expect **~1–3 minutes** for a typical warm Node/Go repo; first image pull is slower.

## Reload after this change

On `chrome://extensions`, click **Reload** on RepoGuard (accept host access for `127.0.0.1:3847` if prompted). Refresh any open GitHub tabs so the content script updates.

### Permissions

- `activeTab` / `scripting` — read the active tab and list paths on GitHub  
- `storage` — selection + last scan  
- `sidePanel` — docked extension UI  
- `api.github.com` / `raw.githubusercontent.com` — fetch trees and file contents  
- `github.com` — content script path discovery  
- `http://127.0.0.1:3847` — local build agent  

## Rate limits

Unauthenticated GitHub API access is roughly **60 requests/hour**. Each scan uses a few API calls plus raw file downloads. Public repos only in this version. Build checks clone via `git` (separate from the API quota).

## Load locally (unpacked)

1. Open Chrome → `chrome://extensions`
2. Developer mode → **Load unpacked** → this folder
3. (Optional) `cd agent && npm start`
4. Open a GitHub repo → click RepoGuard → select paths → **Scan selection** / **Check build**

## Pack a zip

```bash
cd /Users/arainajain/Desktop/RepoGuard
zip -r ../RepoGuard.zip manifest.json sidepanel.html sidepanel.css sidepanel.js background.js github.js githubApi.js languages.js findings.js rules.js scanner.js selection.js content.js icons bootstrap
```

(The `agent/` folder is run separately; include it in releases if you ship the build-check feature.)

## Project layout

```
RepoGuard/
  manifest.json
  sidepanel.html/css/js   # Docked UI (select + scan + build + findings)
  background.js           # Side panel behavior, RG_SCAN, agent proxy
  content.js              # Path discovery on GitHub pages
  agent/                  # Local Docker build agent (localhost:3847)
  selection.js
  github.js / githubApi.js
  languages.js / rules.js / scanner.js / findings.js
  icons/
  tests/
```

### Languages scanned (heuristics)

See [`languages.js`](languages.js) for the extension list (JS/TS, Python, JVM, Go, Rust, C/C++, shells, configs, templates, …).
