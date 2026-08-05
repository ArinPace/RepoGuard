#!/bin/bash
# One-liner install/start for RepoGuard local agent:
#   curl -fsSL https://raw.githubusercontent.com/ArinPace/RepoGuard/main/bootstrap/install.sh | bash
set -euo pipefail

ROOT="${HOME}/.repoguard"
SRC="${ROOT}/src"
AGENT="${SRC}/agent"
LOG="${ROOT}/agent.log"
PIDFILE="${ROOT}/agent.pid"
REPO_URL="${REPOGUARD_REPO_URL:-https://github.com/ArinPace/RepoGuard.git}"

mkdir -p "${ROOT}"
echo "=== RepoGuard agent ==="

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing dependency: $1"
    echo "$2"
    exit 1
  fi
}

need git "Install git, then re-run this script."
need node "Install Node.js 18+ from https://nodejs.org/ then re-run."
need docker "Install Docker Desktop from https://www.docker.com/products/docker-desktop/ then re-run."
need curl "Install curl, then re-run."

if ! docker info >/dev/null 2>&1; then
  echo "Starting Docker…"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    open -a Docker 2>/dev/null || true
  fi
  for _ in $(seq 1 60); do
    docker info >/dev/null 2>&1 && break
    sleep 2
  done
  if ! docker info >/dev/null 2>&1; then
    echo "Docker is not ready. Open Docker Desktop and re-run."
    exit 1
  fi
fi

if [[ -d "${SRC}/.git" ]]; then
  echo "Updating sources…"
  git -C "${SRC}" fetch --depth 1 origin main 2>/dev/null \
    || git -C "${SRC}" fetch --depth 1 origin master \
    || true
  git -C "${SRC}" reset --hard FETCH_HEAD 2>/dev/null || true
else
  echo "Downloading RepoGuard…"
  rm -rf "${SRC}"
  git clone --depth 1 "${REPO_URL}" "${SRC}"
fi

if curl -sf "http://127.0.0.1:3847/v1/health" >/dev/null 2>&1; then
  echo "Agent already online at http://127.0.0.1:3847"
  exit 0
fi

if [[ -f "${PIDFILE}" ]]; then
  OLD_PID="$(cat "${PIDFILE}" 2>/dev/null || true)"
  if [[ -n "${OLD_PID}" ]] && kill -0 "${OLD_PID}" 2>/dev/null; then
    kill "${OLD_PID}" 2>/dev/null || true
    sleep 1
  fi
fi

echo "Starting agent on 127.0.0.1:3847…"
cd "${AGENT}"
nohup node src/index.js >>"${LOG}" 2>&1 &
echo $! >"${PIDFILE}"

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:3847/v1/health" >/dev/null 2>&1; then
    echo "Ready. Return to Chrome → Test production."
    exit 0
  fi
  sleep 0.25
done

echo "Agent failed to start. Log: ${LOG}"
tail -n 50 "${LOG}" || true
exit 1
