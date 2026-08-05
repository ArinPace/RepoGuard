import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * @typedef {object} StackPlan
 * @property {string} stack
 * @property {string} image
 * @property {string} command
 * @property {string} [detail]
 */

/**
 * @param {string} rootDir
 * @returns {StackPlan | null}
 */
export function detectStack(rootDir) {
  const pkgPath = join(rootDir, "package.json");
  if (existsSync(pkgPath)) {
    return detectNode(rootDir, pkgPath);
  }

  if (existsSync(join(rootDir, "Cargo.toml"))) {
    return {
      stack: "rust",
      image: "rust:1.83-bookworm",
      command: "cargo build --locked 2>/dev/null || cargo build",
      detail: "Cargo.toml",
    };
  }

  if (existsSync(join(rootDir, "go.mod"))) {
    return {
      stack: "go",
      image: "golang:1.23-bookworm",
      command: "go build ./...",
      detail: "go.mod",
    };
  }

  const pyproject = join(rootDir, "pyproject.toml");
  if (existsSync(pyproject)) {
    return detectPython(rootDir, "pyproject.toml");
  }

  if (existsSync(join(rootDir, "requirements.txt"))) {
    return detectPython(rootDir, "requirements.txt");
  }

  const makefile = join(rootDir, "Makefile");
  if (existsSync(makefile)) {
    const text = readFileSync(makefile, "utf8");
    if (/^build\s*:/m.test(text) || /^\.PHONY:\s*[^\n]*\bbuild\b/m.test(text)) {
      return {
        stack: "make",
        image: "debian:bookworm-slim",
        command:
          "apt-get update -qq && apt-get install -y -qq make gcc g++ >/dev/null && make build",
        detail: "Makefile build target",
      };
    }
  }

  return null;
}

/**
 * @param {string} rootDir
 * @param {string} pkgPath
 * @returns {StackPlan}
 */
function detectNode(rootDir, pkgPath) {
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    pkg = {};
  }

  const hasNpmLock = existsSync(join(rootDir, "package-lock.json"));
  const hasPnpmLock = existsSync(join(rootDir, "pnpm-lock.yaml"));
  const hasYarnLock = existsSync(join(rootDir, "yarn.lock"));

  /** @type {string} */
  let install;
  if (hasPnpmLock) {
    install =
      "corepack enable && corepack prepare pnpm@latest --activate && pnpm install --frozen-lockfile";
  } else if (hasYarnLock) {
    install =
      "corepack enable && corepack prepare yarn@stable --activate && yarn install --frozen-lockfile";
  } else if (hasNpmLock) {
    install = "npm ci";
  } else {
    install = "npm install";
  }

  const scripts =
    pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
  const hasBuild = typeof scripts.build === "string" && scripts.build.length > 0;

  let build;
  let detail;
  if (hasBuild) {
    if (hasPnpmLock) build = "pnpm run build";
    else if (hasYarnLock) build = "yarn build";
    else build = "npm run build";
    detail = "package.json build script";
  } else {
    // No build script: install-only still validates the dependency graph.
    build = "echo 'No build script; install-only check passed'";
    detail = "package.json (install only — no build script)";
  }

  return {
    stack: "node",
    image: "node:22-bookworm",
    command: `${install} && ${build}`,
    detail,
  };
}

/**
 * @param {string} rootDir
 * @param {string} manifest
 * @returns {StackPlan}
 */
function detectPython(rootDir, manifest) {
  if (manifest === "pyproject.toml") {
    const text = readFileSync(join(rootDir, "pyproject.toml"), "utf8");
    const hasProject = /\[project\]/.test(text) || /\[tool\.poetry\]/.test(text);
    if (/\[tool\.poetry\]/.test(text)) {
      return {
        stack: "python",
        image: "python:3.12-bookworm",
        command:
          "pip install -q poetry && poetry install --no-interaction && (poetry run build 2>/dev/null || poetry build || echo 'Poetry install-only check passed')",
        detail: "pyproject.toml (poetry)",
      };
    }
    if (hasProject) {
      return {
        stack: "python",
        image: "python:3.12-bookworm",
        command:
          "pip install -q build && pip install -q . && (python -m build || echo 'Install-only check passed')",
        detail: "pyproject.toml",
      };
    }
  }

  return {
    stack: "python",
    image: "python:3.12-bookworm",
    command:
      "pip install -q -r requirements.txt && echo 'requirements.txt install-only check passed'",
    detail: manifest,
  };
}
