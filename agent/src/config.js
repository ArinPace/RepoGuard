import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

const agentRoot = dirname(fileURLToPath(import.meta.url));

/** Shared agent defaults. */

export const AGENT_PORT = Number(process.env.REPOGUARD_AGENT_PORT || 3847);
export const AGENT_HOST = process.env.REPOGUARD_AGENT_HOST || "127.0.0.1";

/** Wall-clock limit for clone + build (ms). */
export const JOB_TIMEOUT_MS = Number(
  process.env.REPOGUARD_JOB_TIMEOUT_MS || 10 * 60 * 1000,
);

/** Max log bytes retained / returned to clients. */
export const LOG_TAIL_BYTES = Number(
  process.env.REPOGUARD_LOG_TAIL_BYTES || 256 * 1024,
);

export const DOCKER_MEMORY = process.env.REPOGUARD_DOCKER_MEMORY || "2g";
export const DOCKER_CPUS = process.env.REPOGUARD_DOCKER_CPUS || "2";

export const WORK_ROOT =
  process.env.REPOGUARD_WORK_ROOT || join(agentRoot, "..", ".work");
