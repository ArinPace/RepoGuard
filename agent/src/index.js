/**
 * RepoGuard local build agent — binds to 127.0.0.1 only.
 *
 * Endpoints:
 *   GET  /v1/health
 *   POST /v1/build   { owner, repo, ref? }
 *   GET  /v1/jobs/:id
 */
import { createServer } from "node:http";
import { AGENT_HOST, AGENT_PORT } from "./config.js";
import { dockerAvailable } from "./docker.js";
import { createBuildJob, getJob, serializeJob } from "./jobs.js";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * @param {import("node:http").IncomingMessage} req
 */
function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} body
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...CORS,
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  const method = req.method || "GET";
  const url = new URL(req.url || "/", `http://${AGENT_HOST}:${AGENT_PORT}`);

  if (method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  try {
    if (method === "GET" && url.pathname === "/v1/health") {
      const docker = await dockerAvailable();
      sendJson(res, 200, {
        ok: true,
        service: "repoguard-agent",
        version: "0.1.0",
        docker,
        time: Date.now(),
      });
      return;
    }

    if (method === "POST" && url.pathname === "/v1/build") {
      const body = await readJson(req);
      const job = createBuildJob({
        owner: body.owner,
        repo: body.repo,
        ref: body.ref,
      });
      sendJson(res, 202, { ok: true, job: serializeJob(job) });
      return;
    }

    const jobMatch = url.pathname.match(/^\/v1\/jobs\/([^/]+)$/);
    if (method === "GET" && jobMatch) {
      const job = getJob(jobMatch[1]);
      if (!job) {
        sendJson(res, 404, { ok: false, error: "Job not found" });
        return;
      }
      sendJson(res, 200, { ok: true, job: serializeJob(job) });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" });
  } catch (error) {
    sendJson(res, 400, {
      ok: false,
      error: String(error?.message || error),
    });
  }
});

server.listen(AGENT_PORT, AGENT_HOST, () => {
  console.log(
    `RepoGuard agent listening on http://${AGENT_HOST}:${AGENT_PORT}`,
  );
  console.log("Endpoints: GET /v1/health  POST /v1/build  GET /v1/jobs/:id");
});

server.on("error", (error) => {
  console.error("Agent failed to start:", error.message || error);
  process.exit(1);
});
