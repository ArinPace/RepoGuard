import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { WORK_ROOT } from "./config.js";

/**
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(command, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`Command timed out: ${command} ${args.join(" ")}`));
          }, opts.timeoutMs)
        : null;

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * Shallow-clone a public GitHub repo into a fresh work directory.
 * @param {{ owner: string, repo: string, ref?: string, jobId: string }} opts
 * @returns {Promise<string>} absolute path to clone
 */
export async function shallowClone({ owner, repo, ref, jobId }) {
  const safeOwner = String(owner).replace(/[^A-Za-z0-9_.-]/g, "");
  const safeRepo = String(repo).replace(/[^A-Za-z0-9_.-]/g, "");
  if (!safeOwner || !safeRepo || safeOwner !== owner || safeRepo !== repo) {
    throw new Error("Invalid owner/repo for clone.");
  }

  await mkdir(WORK_ROOT, { recursive: true });
  const dest = join(WORK_ROOT, jobId);
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });

  const url = `https://github.com/${owner}/${repo}.git`;
  const args = ["clone", "--depth", "1", "--single-branch"];
  if (ref) {
    args.push("--branch", String(ref));
  }
  args.push(url, dest);

  const result = await run("git", args, { timeoutMs: 120_000 });
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `git clone failed (exit ${result.code})${detail ? `: ${detail.slice(0, 500)}` : ""}`,
    );
  }
  return dest;
}

/**
 * @param {string} dir
 */
export async function cleanupClone(dir) {
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}
