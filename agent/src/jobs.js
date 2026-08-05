import { randomUUID } from "node:crypto";
import { shallowClone, cleanupClone } from "./clone.js";
import { detectStack } from "./detect.js";
import { dockerAvailable, runBuildInDocker, tailBytes } from "./docker.js";
import { JOB_TIMEOUT_MS, LOG_TAIL_BYTES } from "./config.js";

/** @typedef {"queued" | "cloning" | "detecting" | "building" | "done" | "error"} JobStatus */

/**
 * @typedef {object} BuildJob
 * @property {string} id
 * @property {JobStatus} status
 * @property {string} owner
 * @property {string} repo
 * @property {string} [ref]
 * @property {number} createdAt
 * @property {number} [startedAt]
 * @property {number} [finishedAt]
 * @property {string} [phase]
 * @property {string} log
 * @property {object} [result]
 * @property {string} [error]
 */

/** @type {Map<string, BuildJob>} */
const jobs = new Map();

const MAX_JOBS = 50;

function trimJobs() {
  if (jobs.size <= MAX_JOBS) return;
  const ordered = [...jobs.values()].sort((a, b) => a.createdAt - b.createdAt);
  while (jobs.size > MAX_JOBS && ordered.length) {
    const old = ordered.shift();
    if (old && (old.status === "done" || old.status === "error")) {
      jobs.delete(old.id);
    } else {
      break;
    }
  }
}

/**
 * @param {BuildJob} job
 * @param {string} chunk
 */
function appendLog(job, chunk) {
  job.log = tailBytes(`${job.log || ""}${chunk}`, LOG_TAIL_BYTES);
}

/**
 * @param {{ owner: string, repo: string, ref?: string }} input
 */
export function createBuildJob(input) {
  const owner = String(input.owner || "").trim();
  const repo = String(input.repo || "").trim();
  if (!owner || !repo) {
    throw new Error("owner and repo are required");
  }

  const id = randomUUID();
  /** @type {BuildJob} */
  const job = {
    id,
    status: "queued",
    owner,
    repo,
    ref: input.ref ? String(input.ref) : undefined,
    createdAt: Date.now(),
    phase: "queued",
    log: "",
  };
  jobs.set(id, job);
  trimJobs();

  // Fire and forget
  runJob(job).catch((error) => {
    job.status = "error";
    job.error = String(error?.message || error);
    job.finishedAt = Date.now();
    appendLog(job, `\n[agent] ${job.error}\n`);
  });

  return job;
}

/**
 * @param {string} id
 */
export function getJob(id) {
  return jobs.get(id) || null;
}

/**
 * @param {BuildJob} job
 */
async function runJob(job) {
  job.startedAt = Date.now();
  const deadline = job.startedAt + JOB_TIMEOUT_MS;
  let workDir = null;

  const remaining = () => Math.max(5_000, deadline - Date.now());

  try {
    const dockerOk = await dockerAvailable();
    if (!dockerOk) {
      throw new Error(
        "Docker is not available. Install Docker Desktop and ensure the daemon is running.",
      );
    }

    job.status = "cloning";
    job.phase = "cloning";
    appendLog(
      job,
      `[agent] Cloning github.com/${job.owner}/${job.repo}` +
        (job.ref ? ` @ ${job.ref}` : "") +
        "…\n",
    );

    workDir = await shallowClone({
      owner: job.owner,
      repo: job.repo,
      ref: job.ref,
      jobId: job.id,
    });
    appendLog(job, `[agent] Clone ready: ${workDir}\n`);

    job.status = "detecting";
    job.phase = "detecting";
    const plan = detectStack(workDir);
    if (!plan) {
      job.status = "done";
      job.finishedAt = Date.now();
      job.result = {
        ok: false,
        exitCode: null,
        durationMs: job.finishedAt - job.startedAt,
        stack: null,
        command: null,
        logTail: tailBytes(job.log),
        error:
          "Unsupported stack: no package.json, Cargo.toml, go.mod, pyproject.toml, requirements.txt, or Makefile with a build target.",
        unsupported: true,
      };
      appendLog(job, `[agent] ${job.result.error}\n`);
      return;
    }

    appendLog(
      job,
      `[agent] Detected ${plan.stack} (${plan.detail || plan.image})\n` +
        `[agent] Image: ${plan.image}\n` +
        `[agent] Command: ${plan.command}\n`,
    );

    job.status = "building";
    job.phase = "downloading";
    appendLog(
      job,
      "[agent] Downloading toolchain image (if needed), then install + build…\n",
    );
    const containerName = `repoguard-build-${job.id.slice(0, 8)}`;
    const build = await runBuildInDocker({
      workDir,
      image: plan.image,
      command: plan.command,
      containerName,
      timeoutMs: remaining(),
      onOutput: (chunk) => {
        if (job.phase === "downloading" && /Image ready:/.test(chunk)) {
          job.phase = "building";
        }
        appendLog(job, chunk);
      },
    });
    job.phase = "building";

    job.finishedAt = Date.now();
    const durationMs = job.finishedAt - job.startedAt;
    const ok = !build.timedOut && build.exitCode === 0;

    if (build.timedOut) {
      appendLog(job, "\n[agent] Build timed out.\n");
    }

    job.status = "done";
    job.result = {
      ok,
      exitCode: build.exitCode,
      durationMs,
      stack: plan.stack,
      image: plan.image,
      command: plan.command,
      detail: plan.detail,
      logTail: tailBytes(`${job.log}\n${build.log || ""}`),
      timedOut: Boolean(build.timedOut),
      error: ok
        ? undefined
        : build.timedOut
          ? "Build timed out"
          : build.error || `Build exited with code ${build.exitCode}`,
    };
    appendLog(
      job,
      `[agent] Finished ${ok ? "OK" : "FAILED"} in ${durationMs}ms (exit ${build.exitCode})\n`,
    );
  } catch (error) {
    job.status = "error";
    job.finishedAt = Date.now();
    job.error = String(error?.message || error);
    appendLog(job, `\n[agent] Error: ${job.error}\n`);
    job.result = {
      ok: false,
      exitCode: null,
      durationMs: job.finishedAt - (job.startedAt || job.createdAt),
      stack: null,
      command: null,
      logTail: tailBytes(job.log),
      error: job.error,
    };
  } finally {
    if (workDir) {
      await cleanupClone(workDir);
    }
  }
}

/**
 * Public summary for HTTP responses.
 * @param {BuildJob} job
 */
export function serializeJob(job) {
  return {
    id: job.id,
    status: job.status,
    phase: job.phase,
    owner: job.owner,
    repo: job.repo,
    ref: job.ref || null,
    createdAt: job.createdAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    log: job.log,
    result: job.result || null,
    error: job.error || null,
  };
}
