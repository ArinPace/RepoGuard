#!/bin/bash
# RepoGuard one-time / always-on local agent starter.
# Double-click this file (or run from Terminal). It will:
#   1) Ensure Docker Desktop is running
#   2) Download/update RepoGuard agent sources
#   3) Start the agent on http://127.0.0.1:3847
set -euo pipefail

ROOT="${HOME}/.repoguard"
SRC="${ROOT}/src"
AGENT="${SRC}/agent"
LOG="${ROOT}/agent.log"
PIDFILE="${ROOT}/agent.pid"
REPO_URL="${REPOGUARD_REPO_URL:-https://github.com/ArinPace/RepoGuard.git}"

mkdir -p "${ROOT}"

echo "=== RepoGuard agent setup ==="
echo "Install dir: ${ROOT}"

# --- Docker ---
if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed."
  echo "Install Docker Desktop from https://www.docker.com/products/docker-desktop/"
  echo "Then run this starter again."
  if command -v open >/dev/null 2>&1; then
    open "https://www.docker.com/products/docker-desktop/" || true
  fi
  read -r -p "Press Enter to close…" _
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker Desktop…"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    open -a Docker || true
  fi
  echo "Waiting for Docker daemon…"
  for _ in $(seq 1 60); do
    if docker info >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  if ! docker info >/dev/null 2>&1; then
    echo "Docker did not become ready. Open Docker Desktop and try again."
    read -r -p "Press Enter to close…" _
    exit 1
  fi
fi
echo "Docker is ready."

# --- Node ---
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required (v18+)."
  echo "Install from https://nodejs.org/ and run this starter again."
  if command -v open >/dev/null 2>&1; then
    open "https://nodejs.org/" || true
  fi
  read -r -p "Press Enter to close…" _
  exit 1
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required."
  read -r -p "Press Enter to close…" _
  exit 1
fi

# --- Fetch / update agent sources ---
if [[ -d "${SRC}/.git" ]]; then
  echo "Updating RepoGuard…"
  git -C "${SRC}" fetch --depth 1 origin main 2>/dev/null || git -C "${SRC}" fetch --depth 1 origin master || true
  git -C "${SRC}" reset --hard FETCH_HEAD 2>/dev/null || true
else
  echo "Downloading RepoGuard agent…"
  rm -rf "${SRC}"
  git clone --depth 1 "${REPO_URL}" "${SRC}"
fi

if [[ ! -d "${AGENT}" ]]; then
  echo "Agent folder missing after download."
  exit 1
fi

# --- Already running? ---
if curl -sf "http://127.0.0.1:3847/v1/health" >/dev/null 2>&1; then
  echo "Agent already running on http://127.0.0.1:3847"
  echo "You can close this window and click Test production again."
  sleep 3
  exit 0
fi

if [[ -f "${PIDFILE}" ]]; then
  OLD_PID="$(cat "${PIDFILE}" 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
    echo "Stopping previous agent (pid ${OLD_PID})…"
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 1
  fi
fi

echo "Starting agent…"
cd "${AGENT}"
nohup node src/index.js >>"${LOG}" 2>&1 &
echo $! >"${PIDFILE}"

for _ in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:3847/v1/health" >/dev/null 2>&1; then
    echo "Agent is online at http://127.0.0.1:3847"
    echo "Return to Chrome and click Test production — it will pull images and build automatically."
    sleep 4
    exit 0
  fi
  sleep 0.5
done

echo "Agent did not respond. Check log: ${LOG}"
tail -n 40 "${LOG}" || true
read -r -p "Press Enter to close…" _
exit 1
