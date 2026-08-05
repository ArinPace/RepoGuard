import { spawn } from "node:child_process";
import {
  DOCKER_CPUS,
  DOCKER_MEMORY,
  JOB_TIMEOUT_MS,
  LOG_TAIL_BYTES,
} from "./config.js";

/**
 * @param {string} text
 * @param {number} maxBytes
 */
export function tailBytes(text, maxBytes = LOG_TAIL_BYTES) {
  const buf = Buffer.from(String(text || ""), "utf8");
  if (buf.length <= maxBytes) return buf.toString("utf8");
  return buf.subarray(buf.length - maxBytes).toString("utf8");
}

/**
 * @returns {Promise<boolean>}
 */
export async function dockerAvailable() {
  try {
    const result = await runDocker(["version", "--format", "{{.Server.Version}}"], {
      timeoutMs: 15_000,
    });
    return result.code === 0;
  } catch {
    return false;
  }
}

/**
 * @param {string[]} args
 * @param {{ timeoutMs?: number, onOutput?: (chunk: string) => void }} [opts]
 */
function runDocker(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { env: process.env });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            if (settled) return;
            child.kill("SIGKILL");
            // Also try to kill the container if we know the name — handled by caller.
            reject(new Error(`docker timed out after ${opts.timeoutMs}ms`));
          }, opts.timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      opts.onOutput?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      opts.onOutput?.(text);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (!settled) {
        settled = true;
        resolve({ code, stdout, stderr });
      }
    });
  });
}

/**
 * Run install+build inside an ephemeral Docker container.
 * @param {{
 *   workDir: string,
 *   image: string,
 *   command: string,
 *   containerName: string,
 *   timeoutMs?: number,
 *   onOutput?: (chunk: string) => void,
 * }} opts
 */
export async function runBuildInDocker(opts) {
  const timeoutMs = opts.timeoutMs ?? JOB_TIMEOUT_MS;
  const args = [
    "run",
    "--rm",
    "--name",
    opts.containerName,
    "--network=bridge",
    `--memory=${DOCKER_MEMORY}`,
    `--cpus=${DOCKER_CPUS}`,
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "-v",
    `${opts.workDir}:/work`,
    "-w",
    "/work",
    opts.image,
    "bash",
    "-lc",
    opts.command,
  ];

  try {
    const result = await runDocker(args, {
      timeoutMs,
      onOutput: opts.onOutput,
    });
    const combined = `${result.stdout}${result.stderr}`;
    return {
      exitCode: result.code ?? 1,
      log: tailBytes(combined),
      timedOut: false,
    };
  } catch (error) {
    // Best-effort kill if timeout left a named container.
    await runDocker(["rm", "-f", opts.containerName], { timeoutMs: 10_000 }).catch(
      () => {},
    );
    const message = String(error?.message || error);
    const timedOut = /timed out/i.test(message);
    return {
      exitCode: 124,
      log: tailBytes(message),
      timedOut,
      error: message,
    };
  }
}
