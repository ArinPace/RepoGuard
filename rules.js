// Heuristic rules: regex patterns that flag *possible* issues for learning.
// A match is not proof of exploitability — treat findings as teaching signals.
// Scope 2C: broader rule pack (secrets, injection, XSS, crypto, config, mild).

import {
  JS_LIKE,
  PY_LIKE,
  RUBY_LIKE,
  PHP_LIKE,
  GO_LIKE,
  JAVA_LIKE,
  RUST_LIKE,
  CSHARP_LIKE,
  C_LIKE,
  PERL_LIKE,
  LUA_LIKE,
  SHELL_LIKE,
  CODE_LIKE,
  YAML_LIKE,
  CONFIG_LIKE,
  SQL_LIKE,
} from "./languages.js";

/**
 * @typedef {"severe" | "moderate" | "mild"} Severity
 *
 * @typedef {object} RuleHit
 * @property {string} ruleId
 * @property {Severity} severity
 * @property {string} title
 * @property {string} why
 * @property {string} fix
 *
 * @typedef {object} Rule
 * @property {string} id
 * @property {Severity} severity
 * @property {string} title
 * @property {string} why
 * @property {string} fix
 * @property {(filePath: string, line: number, lineText: string) => boolean} test
 */

function baseName(filePath) {
  return filePath.split("/").pop() || "";
}

function isLockfile(filePath) {
  const base = baseName(filePath);
  return (
    base === "package-lock.json" ||
    base === "yarn.lock" ||
    base === "pnpm-lock.yaml" ||
    base === "Cargo.lock" ||
    base === "composer.lock" ||
    base === "Gemfile.lock" ||
    base === "poetry.lock" ||
    base === "Pipfile.lock"
  );
}

function isCommentLine(lineText) {
  const t = lineText.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("#") ||
    t.startsWith("*") ||
    t.startsWith("<!--") ||
    t.startsWith("--") || // SQL
    t.startsWith(";") // Lisp / some inis
  );
}

/** @type {Rule[]} */
export const RULES = [
  // ─── Secrets (severe) ─────────────────────────────────────────────
  {
    id: "secret.aws-access-key",
    severity: "severe",
    title: "Possible AWS access key id",
    why: "AWS access key IDs in source are often paired with secrets nearby. Attackers scrape public repos for cloud credentials and can run up bills or access your account.",
    fix: "Remove the key from the repo, rotate it in AWS IAM, store credentials in environment variables or a secrets manager, and add secret-scanning to CI.",
    test(_filePath, _line, lineText) {
      return /\b(AKIA|ASIA)[0-9A-Z]{16}\b/.test(lineText);
    },
  },
  {
    id: "secret.private-key-pem",
    severity: "severe",
    title: "Possible private key in source",
    why: "PEM private keys in a repository mean anyone with read access can impersonate that key (SSH, TLS, JWT signing, etc.).",
    fix: "Delete the key from git history if needed, generate a new key pair, never commit private keys, and load them from a secure store at runtime.",
    test(_filePath, _line, lineText) {
      return /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----/.test(
        lineText,
      );
    },
  },
  {
    id: "secret.api-key-assignment",
    severity: "severe",
    title: "Possible hardcoded API key or secret",
    why: "Long secret-like values assigned to api_key / secret / token variables are frequently real credentials. Once pushed, they live in git history.",
    fix: "Move the value to an environment variable or secrets manager, replace it with a placeholder in code, rotate the exposed secret, and add the env file to .gitignore.",
    test(filePath, _line, lineText) {
      if (isLockfile(filePath)) return false;
      return /\b(api[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*['"][^'"]{12,}['"]/i.test(
        lineText,
      );
    },
  },
  {
    id: "secret.github-token",
    severity: "severe",
    title: "Possible GitHub token",
    why: "GitHub PATs and tokens in a repo can let attackers push code, steal private repos, or abuse Actions.",
    fix: "Revoke the token in GitHub settings, remove it from the repo and history, and use Actions secrets or a secrets manager instead.",
    test(_filePath, _line, lineText) {
      return /\b(gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/.test(
        lineText,
      );
    },
  },
  {
    id: "secret.slack-token",
    severity: "severe",
    title: "Possible Slack API token",
    why: "Slack bot/user tokens in source let attackers read channels, post as your bot, or exfiltrate workspace data.",
    fix: "Revoke the token in Slack, rotate credentials, and load tokens from environment variables at runtime.",
    test(_filePath, _line, lineText) {
      return /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/.test(lineText);
    },
  },
  {
    id: "secret.password-assignment",
    severity: "severe",
    title: "Possible hardcoded password",
    why: "Passwords embedded in source are visible to anyone with repo access and often get reused elsewhere.",
    fix: "Never commit passwords. Use a secrets manager or env vars, and rotate any password that was committed.",
    test(filePath, _line, lineText) {
      if (isLockfile(filePath) || isCommentLine(lineText)) return false;
      if (/type\s*=\s*['"]password['"]/i.test(lineText)) return false;
      return /\b(password|passwd|pwd)\b\s*[:=]\s*['"][^'"]{6,}['"]/i.test(
        lineText,
      );
    },
  },
  {
    id: "secret.jwt-like",
    severity: "severe",
    title: "Possible JWT or session token literal",
    why: "Hardcoded JWTs/session strings are often long-lived credentials. If committed, they can be replayed until they expire.",
    fix: "Do not commit tokens. Issue them at runtime and store only in secure client storage / httpOnly cookies as appropriate.",
    test(filePath, _line, lineText) {
      if (isLockfile(filePath)) return false;
      return /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/.test(
        lineText,
      );
    },
  },

  // ─── Injection / dangerous sinks (severe) ─────────────────────────
  {
    id: "sql.concat",
    severity: "severe",
    title: "SQL built with string concatenation or interpolation",
    why: "Building SQL by concatenating or interpolating values lets attackers change the query (SQL injection), which can leak or destroy data.",
    fix: "Use parameterized queries / prepared statements so user values are bound separately from the SQL string.",
    test(filePath, _line, lineText) {
      if (
        !CODE_LIKE.test(filePath) &&
        !SQL_LIKE.test(filePath)
      ) {
        return false;
      }
      if (isCommentLine(lineText)) return false;
      const hasSqlVerb =
        /\b(SELECT|INSERT|UPDATE|DELETE|FROM|WHERE|JOIN)\b/i.test(lineText);
      if (!hasSqlVerb) return false;

      if (/['"`].*\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(lineText)) {
        if (/\+\s*\w+|['"`]\s*\+|\+\s*['"`]/.test(lineText)) return true;
        if (/`[^`]*\$\{[^}]+\}[^`]*`/.test(lineText)) return true;
      }

      if (
        /%s|%\(|\.format\s*\(|f['"].*\b(SELECT|INSERT|UPDATE|DELETE)\b/i.test(
          lineText,
        )
      ) {
        return true;
      }

      if (
        /\b(query|execute|raw|sequelize\.query|knex\.raw)\s*\(\s*['"`][^'"`]*(SELECT|INSERT|UPDATE|DELETE)/i.test(
          lineText,
        )
      ) {
        if (/\+|\$\{/.test(lineText)) return true;
      }

      return false;
    },
  },
  {
    id: "code.eval",
    severity: "severe",
    title: "Use of eval()",
    why: "eval() runs a string as code. If any part of that string is attacker-controlled, they can execute arbitrary JavaScript in your app.",
    fix: "Avoid eval. Prefer JSON.parse for data, or explicit parsers/maps for known commands.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /(^|[^.\w])eval\s*\(/.test(lineText);
    },
  },
  {
    id: "code.function-constructor",
    severity: "severe",
    title: "Use of new Function()",
    why: "new Function(...) compiles a string into executable code — similar risk profile to eval().",
    fix: "Refactor so you do not build functions from strings. Use plain functions or a command map.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\bnew\s+Function\s*\(/.test(lineText);
    },
  },
  {
    id: "code.child-process-exec",
    severity: "severe",
    title: "Shell command via child_process exec/execSync",
    why: "exec runs a shell. If user input is concatenated into the command string, attackers can run extra OS commands (command injection).",
    fix: "Prefer child_process.execFile/spawn with an argument array (no shell). Never concatenate untrusted input into a shell string.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\b(child_process\.)?execSync\s*\(/.test(lineText) ||
        /\brequire\s*\(\s*['"]child_process['"]\s*\)[\s\S]{0,40}\.exec\s*\(/.test(
          lineText,
        ) ||
        /\bchild_process\.exec\s*\(/.test(lineText) ||
        /\bcp\.exec(Sync)?\s*\(/.test(lineText)
      );
    },
  },
  {
    id: "py.exec-eval",
    severity: "severe",
    title: "Python eval() or exec()",
    why: "eval/exec run dynamic Python. Untrusted input here is full remote code execution.",
    fix: "Do not eval user input. Use ast.literal_eval for simple literals, or parse with an explicit schema.",
    test(filePath, _line, lineText) {
      if (!PY_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /(^|[^\w])(eval|exec)\s*\(/.test(lineText);
    },
  },
  {
    id: "py.pickle-loads",
    severity: "severe",
    title: "Unsafe pickle.loads / pickle.load",
    why: "Unpickling data from an untrusted source can execute arbitrary code during deserialization.",
    fix: "Never unpickle untrusted data. Prefer JSON. If you must use pickle, only load data you created and signed yourself.",
    test(filePath, _line, lineText) {
      if (!PY_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\bpickle\.(loads|load)\s*\(/.test(lineText);
    },
  },
  {
    id: "py.yaml-unsafe-load",
    severity: "severe",
    title: "Unsafe yaml.load()",
    why: "yaml.load without a SafeLoader can construct arbitrary Python objects from YAML — a classic RCE pattern.",
    fix: "Use yaml.safe_load() or yaml.load(..., Loader=SafeLoader).",
    test(filePath, _line, lineText) {
      if (!PY_LIKE.test(filePath) && !YAML_LIKE.test(filePath)) return false;
      if (isCommentLine(lineText)) return false;
      if (!/\byaml\.load\s*\(/.test(lineText)) return false;
      if (/\bsafe_load\b|SafeLoader|CSafeLoader/.test(lineText)) return false;
      return true;
    },
  },
  {
    id: "ruby.command-injection",
    severity: "severe",
    title: "Ruby shell execution (system/exec/backticks/`%x`)",
    why: "Ruby system, exec, open('|...'), backticks, and %x run a shell. Untrusted input concatenated here is command injection.",
    fix: "Prefer Process.spawn with an argument array, or libraries that do not invoke a shell. Never interpolate user input into a shell string.",
    test(filePath, _line, lineText) {
      if (!RUBY_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\b(system|exec|spawn)\s*\(/.test(lineText) ||
        /\bopen\s*\(\s*['"]\|/.test(lineText) ||
        /`[^`]+`/.test(lineText) ||
        /%x[({[]/.test(lineText)
      );
    },
  },
  {
    id: "php.eval",
    severity: "severe",
    title: "PHP eval() or assert() with strings",
    why: "eval/assert on strings executes PHP. User-controlled input here is remote code execution.",
    fix: "Remove eval. Use proper parsers, allow-lists, or redesign so dynamic code is unnecessary.",
    test(filePath, _line, lineText) {
      if (!PHP_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /(^|[^\w$])(eval|assert)\s*\(/.test(lineText);
    },
  },
  {
    id: "php.dangerous-include",
    severity: "severe",
    title: "Dynamic PHP include/require",
    why: "Variable include/require paths can become Local/Remote File Inclusion if influenced by users.",
    fix: "Include only fixed paths or a strict allow-list of filenames. Never pass raw request params into include.",
    test(filePath, _line, lineText) {
      if (!PHP_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\b(include|require|include_once|require_once)\s*(\(?\s*\$|\(?\s*['"].*\s*\.|\{)/.test(
        lineText,
      );
    },
  },
  {
    id: "go.unsafe-exec",
    severity: "severe",
    title: "Go os/exec with shell (sh -c / bash -c)",
    why: "Running commands through a shell in Go reintroduces shell injection. Prefer exec.Command with separate arguments.",
    fix: "Use exec.Command(bin, arg1, arg2, ...) without sh -c. Pass each argument as its own array element.",
    test(filePath, _line, lineText) {
      if (!GO_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\bexec\.Command\s*\([^)]*(sh|bash|cmd\.exe|powershell)/i.test(
          lineText,
        ) || /\b"sh"\s*,\s*"-\w*c"/.test(lineText)
      );
    },
  },
  {
    id: "java.runtime-exec",
    severity: "severe",
    title: "Java/Kotlin Runtime.exec or ProcessBuilder",
    why: "Spawning OS processes with concatenated strings can allow command injection.",
    fix: "Use ProcessBuilder with a list of arguments. Avoid shell wrappers; validate or allow-list inputs.",
    test(filePath, _line, lineText) {
      if (!JAVA_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\bRuntime\.getRuntime\s*\(\s*\)\s*\.exec\s*\(/.test(lineText) ||
        /\bProcessBuilder\s*\(/.test(lineText)
      );
    },
  },
  {
    id: "rust.command-shell",
    severity: "severe",
    title: "Rust Command with shell (-c)",
    why: "Invoking sh/bash with -c and a built string is command injection territory in Rust as in other languages.",
    fix: "Use std::process::Command with program + args separately. Do not format user input into a shell script string.",
    test(filePath, _line, lineText) {
      if (!RUST_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\bCommand::new\s*\(\s*"(sh|bash|cmd)"/.test(lineText) ||
        /\.arg\s*\(\s*"-\w*c"\s*\)/.test(lineText)
      );
    },
  },
  {
    id: "csharp.process-shell",
    severity: "severe",
    title: "C# Process with UseShellExecute / cmd",
    why: "Starting processes via the shell or cmd.exe with concatenated input enables command injection on .NET.",
    fix: "Set UseShellExecute=false and pass Arguments carefully, or prefer APIs that take argv-style arguments without a shell.",
    test(filePath, _line, lineText) {
      if (!CSHARP_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\bUseShellExecute\s*=\s*true\b/.test(lineText) ||
        /\bProcess\.Start\s*\(/.test(lineText) ||
        /\bcmd\.exe\b/i.test(lineText)
      );
    },
  },
  {
    id: "shell.curl-pipe-shell",
    severity: "moderate",
    title: "curl/wget piped into a shell",
    why: "curl | sh runs remote script content with full shell privileges. Supply-chain or MITM issues become instant RCE.",
    fix: "Download scripts, verify checksums/signatures, inspect them, then run. Avoid piping untrusted content into sh.",
    test(filePath, _line, lineText) {
      const base = baseName(filePath).toLowerCase();
      const isShell =
        SHELL_LIKE.test(filePath) ||
        base === "dockerfile" ||
        base === "makefile" ||
        base === "procfile";
      if (!isShell || isCommentLine(lineText)) return false;
      return /\b(curl|wget)\b.*\|\s*(sh|bash|zsh)/i.test(lineText);
    },
  },

  // ─── XSS (moderate) ───────────────────────────────────────────────
  {
    id: "xss.innerhtml",
    severity: "moderate",
    title: "Assignment to innerHTML",
    why: "Writing HTML into the DOM via innerHTML can run attacker-controlled scripts (XSS) if any part of that string comes from users or untrusted data.",
    fix: "Prefer textContent for plain text. If you must render HTML, sanitize it with a trusted library.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (/\.innerHTML\s*=\s*['"`]\s*['"`]/.test(lineText)) return false;
      return /\.innerHTML\s*=/.test(lineText);
    },
  },
  {
    id: "xss.outerhtml",
    severity: "moderate",
    title: "Assignment to outerHTML",
    why: "outerHTML replaces the element with parsed HTML — same XSS class of risk as innerHTML when content is untrusted.",
    fix: "Avoid assigning untrusted strings to outerHTML. Rebuild the DOM with createElement/textContent or sanitize first.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\.outerHTML\s*=/.test(lineText);
    },
  },
  {
    id: "xss.document-write",
    severity: "moderate",
    title: "Use of document.write()",
    why: "document.write injects markup into the page. With untrusted input it enables XSS.",
    fix: "Use DOM APIs (createElement, textContent) or a templating approach with escaping/sanitization.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\bdocument\.write(ln)?\s*\(/.test(lineText);
    },
  },
  {
    id: "xss.jquery-html",
    severity: "moderate",
    title: "jQuery .html() with dynamic content",
    why: "jQuery's .html() parses HTML like innerHTML. Passing unsanitized user data is a common XSS bug in older apps.",
    fix: "Use .text() for plain text, or sanitize HTML before .html().",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\.html\s*\(\s*[^)]+/.test(lineText);
    },
  },
  {
    id: "xss.react-dangerously-set-html",
    severity: "moderate",
    title: "React dangerouslySetInnerHTML",
    why: "This React escape hatch injects raw HTML. Without strict sanitization it is XSS by design.",
    fix: "Avoid it when possible. If required, sanitize with a maintained library (e.g. DOMPurify).",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\bdangerouslySetInnerHTML\b/.test(lineText);
    },
  },

  // ─── Crypto / auth weakness ───────────────────────────────────────
  {
    id: "crypto.math-random-secret",
    severity: "moderate",
    title: "Math.random used near token/secret/password",
    why: "Math.random is not cryptographically secure. Tokens or passwords derived from it can be guessed or predicted.",
    fix: "Use crypto.getRandomValues (browser) or crypto.randomBytes / randomUUID (Node) for secrets and session tokens.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (!/\bMath\.random\s*\(/.test(lineText)) return false;
      return /\b(token|secret|password|nonce|session|api[_-]?key)\b/i.test(
        lineText,
      );
    },
  },
  {
    id: "crypto.md5-or-sha1-password",
    severity: "moderate",
    title: "MD5/SHA1 used in a password-like context",
    why: "MD5 and SHA1 are fast and broken for password storage; attackers can crack large lists of hashes cheaply.",
    fix: "Use a slow password KDF: bcrypt, scrypt, or Argon2.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      const hash =
        /\b(md5|sha1)\b/i.test(lineText) ||
        /\bcreateHash\s*\(\s*['"]md5['"]|\bcreateHash\s*\(\s*['"]sha1['"]/.test(
          lineText,
        );
      if (!hash) return false;
      return /\b(password|passwd|pwd|credential)\b/i.test(lineText);
    },
  },
  {
    id: "crypto.nodejs-createcipher",
    severity: "moderate",
    title: "Deprecated crypto.createCipher (not createCipheriv)",
    why: "createCipher derives keys insecurely. Node documents these APIs as legacy and unsafe.",
    fix: "Use createCipheriv / createDecipheriv with a strong key and random IV from crypto.randomBytes.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (/\bcreateCipheriv\b/.test(lineText)) return false;
      return /\bcreateCipher\b/.test(lineText);
    },
  },
  {
    id: "auth.jwt-none-or-weak",
    severity: "severe",
    title: "JWT algorithm none or very weak hardcoded secret",
    why: "algorithm none or empty/short JWT secrets let attackers forge tokens and impersonate users.",
    fix: "Use a strong secret or asymmetric keys (RS256/ES256). Never accept alg none. Load secrets from a secure store.",
    test(filePath, _line, lineText) {
      if (!CONFIG_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (
        /algorithm\s*:\s*['"]none['"]/i.test(lineText) ||
        (/\balgorithms\s*:\s*\[[^\]]*['"]none['"]/i.test(lineText) &&
          /\bjwt|jsonwebtoken/i.test(lineText))
      ) {
        return true;
      }
      return /\b(jwt[_-]?secret|secretOrKey)\b\s*[:=]\s*['"][^'"]{0,8}['"]/i.test(
        lineText,
      );
    },
  },

  // ─── Config / security misconfiguration ───────────────────────────
  {
    id: "config.cors-allow-all",
    severity: "moderate",
    title: "CORS allows any origin (*)",
    why: "Allowing any origin widens who can call your browser-facing API. Combined with cookies/credentials this is especially dangerous.",
    fix: "Allow only specific trusted origins. Avoid * especially with credentials.",
    test(filePath, _line, lineText) {
      if (!CONFIG_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (/Access-Control-Allow-Origin['"\s:=]+['"]?\*/i.test(lineText)) {
        return true;
      }
      if (/\borigin\s*:\s*['"]\*['"]/.test(lineText)) return true;
      if (/\bcors\s*\(\s*\{[^}]*origin\s*:\s*true/i.test(lineText)) return true;
      return false;
    },
  },
  {
    id: "config.tls-verify-disabled",
    severity: "severe",
    title: "TLS certificate verification disabled",
    why: "Turning off TLS verification enables man-in-the-middle attacks: anyone on the network can intercept or alter traffic.",
    fix: "Keep verification on. Fix certificate issues properly. Never disable verify in production.",
    test(filePath, _line, lineText) {
      if (!CONFIG_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\brejectUnauthorized\s*:\s*false\b/.test(lineText) ||
        /\bNODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0['"]?/.test(lineText) ||
        /\bverify\s*=\s*False\b/.test(lineText) ||
        /\binsecureSkipVerify\s*:\s*true\b/i.test(lineText)
      );
    },
  },
  {
    id: "config.debug-enabled",
    severity: "mild",
    title: "Debug mode enabled in code/config",
    why: "Debug flags often expose stack traces or verbose errors that help attackers map your app.",
    fix: "Ensure debug is off in production (env-based config). Return generic errors to clients.",
    test(filePath, _line, lineText) {
      if (!CONFIG_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (isLockfile(filePath)) return false;
      return (
        /\bdebug\s*[:=]\s*true\b/i.test(lineText) ||
        /\bDEBUG\s*=\s*['"]?true['"]?/i.test(lineText)
      );
    },
  },
  {
    id: "config.flask-debug",
    severity: "moderate",
    title: "Flask debug mode enabled",
    why: "Flask debug mode can expose an interactive debugger. If reachable remotely, that is effectively remote code execution.",
    fix: "Never run Flask with debug=True in production. Use a production server and DEBUG=False.",
    test(filePath, _line, lineText) {
      if (!PY_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\bapp\.run\s*\([^)]*\bdebug\s*=\s*True/.test(lineText) ||
        /\bDEBUG\s*=\s*True\b/.test(lineText)
      );
    },
  },
  {
    id: "config.django-secret-key-literal",
    severity: "severe",
    title: "Django SECRET_KEY appears hardcoded",
    why: "Django's SECRET_KEY signs sessions and tokens. A leaked key lets attackers forge cookies and escalate access.",
    fix: "Load SECRET_KEY from an environment variable or secret store. Rotate if it was ever committed.",
    test(filePath, _line, lineText) {
      if (isCommentLine(lineText)) return false;
      return /\bSECRET_KEY\s*=\s*['"][^'"]{8,}['"]/.test(lineText);
    },
  },

  // ─── Common flaws across languages (OWASP-style pack) ─────────────
  {
    id: "path.traversal",
    severity: "severe",
    title: "Possible path traversal (..)",
    why: "Using ../ in file paths (especially with user input) can let attackers read or write files outside the intended directory.",
    fix: "Resolve paths, then ensure the result stays under an allow-listed base directory. Prefer path APIs that reject traversal.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) && !CONFIG_LIKE.test(filePath)) return false;
      if (isCommentLine(lineText) || isLockfile(filePath)) return false;
      if (!/\.\.(\/|\\)/.test(lineText)) return false;
      return /\b(path|file|filename|filepath|open|read|write|sendFile|send_file|createReadStream|include|require)\b/i.test(
        lineText,
      );
    },
  },
  {
    id: "ssrf.user-controlled-url",
    severity: "severe",
    title: "HTTP request may use a user-controlled URL (SSRF)",
    why: "Server-side HTTP clients that take URLs from query/body/params can be abused for SSRF (internal services, cloud metadata). Plain client-side fetch() to an internally built URL is not SSRF.",
    fix: "Allow-list schemes/hosts, block link-local and metadata IPs, and never pass raw request parameters into server-side HTTP clients.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;

      // SSRF needs an untrusted URL. Without a request/user-input signal on
      // this line, client fetch(url) / fetch(`${host}/${id}`) is noise.
      const hasUserControlledUrl =
        /\b(req\.(query|body|params|get)|request\.(args|GET|POST|query|form|json|params|data)|query\.(get|param)|params\[|searchParams\.|URLSearchParams|cgi\.Field|r\.URL\.Query|r\.FormValue|r\.Form\b|Request\.(Query|Form|QueryString)|@RequestParam|getParameter\s*\(|HttpServletRequest|user[_-]?url|target[_-]?url|callback[_-]?url|webhook[_-]?url|redirect[_-]?url)\b/i.test(
          lineText,
        ) ||
        /\$_(GET|POST|REQUEST)\b/.test(lineText);
      if (!hasUserControlledUrl) return false;

      // HTTP client sink on the same line as that user-controlled value.
      return /\b(fetch|axios\.(get|post|put|delete|request|head)|got\(|request\(|http\.(get|request)|https\.(get|request)|urllib\.request|requests\.(get|post|put|delete|head|request)|RestTemplate|HttpClient|WebClient|http\.Get|http\.Post|http\.NewRequest|curl_exec|file_get_contents)\s*\(/i.test(
        lineText,
      );
    },
  },
  {
    id: "redirect.open",
    severity: "moderate",
    title: "Possible open redirect",
    why: "Redirecting to a URL from query/body params lets attackers send victims through your domain to phishing sites.",
    fix: "Only redirect to relative paths or an allow-list of hosts. Never bounce to a raw user-supplied absolute URL.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\b(res\.redirect|response\.redirect|redirect_to|redirect\(|HttpResponseRedirect|Redirect\(|header\s*\(\s*['"]Location)/i.test(
          lineText,
        ) &&
        /\b(req\.(query|body|params)|request\.(GET|POST|args|query)|params\[|query\[|\$_GET|\$_REQUEST)\b/i.test(
          lineText,
        )
      );
    },
  },
  {
    id: "xxe.unsafe-xml",
    severity: "severe",
    title: "XML parser may allow external entities (XXE)",
    why: "Insecure XML parsers can fetch external entities and leak local files or hit internal URLs (XXE).",
    fix: "Disable external entities / DTD resolution. Use safe defaults (defusedxml, secure DocumentBuilderFactory settings, etc.).",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\bFEATURE_SECURE_PROCESSING\s*,\s*false\b/i.test(lineText) ||
        /\bsetExpandEntityReferences\s*\(\s*true\s*\)/.test(lineText) ||
        /\blibxml_disable_entity_loader\s*\(\s*false\s*\)/.test(lineText) ||
        /\bDtdProcessing\s*\.\s*Parse\b/.test(lineText) ||
        /\bXMLInputFactory\.SUPPORT_DTD\b/.test(lineText)
      );
    },
  },
  {
    id: "deser.java-objectinput",
    severity: "severe",
    title: "Java ObjectInputStream deserialization",
    why: "Deserializing untrusted Java objects is a classic RCE path via gadget chains.",
    fix: "Avoid Java serialization for untrusted data. Prefer JSON with explicit types, or strict allow-lists (look-ahead deserialization).",
    test(filePath, _line, lineText) {
      if (!JAVA_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\bObjectInputStream\b|\.readObject\s*\(/.test(lineText);
    },
  },
  {
    id: "deser.php-unserialize",
    severity: "severe",
    title: "PHP unserialize()",
    why: "unserialize on attacker-controlled data can invoke magic methods and lead to remote code execution.",
    fix: "Use JSON. If you must unserialize, only on trusted data and prefer allowed_classes options.",
    test(filePath, _line, lineText) {
      if (!PHP_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /(^|[^\w])unserialize\s*\(/.test(lineText);
    },
  },
  {
    id: "deser.ruby-marshal",
    severity: "severe",
    title: "Ruby Marshal.load",
    why: "Marshal.load on untrusted input can instantiate arbitrary objects and execute code during load.",
    fix: "Never Marshal.load user data. Use JSON or another safe format.",
    test(filePath, _line, lineText) {
      if (!RUBY_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /\bMarshal\.load\s*\(/.test(lineText);
    },
  },
  {
    id: "c.dangerous-string-apis",
    severity: "severe",
    title: "Dangerous C/C++ string API (gets/strcpy/sprintf)",
    why: "gets, strcpy, sprintf, and strcat do not bound writes and are a leading cause of buffer overflows.",
    fix: "Use fgets, strncpy/strlcpy, snprintf, or C++ std::string. Enable compiler fortify/sanitizer flags.",
    test(filePath, _line, lineText) {
      if (!C_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return /(^|[^\w])(gets|strcpy|strcat|sprintf|vsprintf)\s*\(/.test(
        lineText,
      );
    },
  },
  {
    id: "ssti.template-string",
    severity: "severe",
    title: "Server-side template built from a string",
    why: "Rendering templates from dynamic strings (SSTI) can let attackers run code inside the template engine.",
    fix: "Use static template files and pass data as context. Never concatenate user input into template source.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\brender_template_string\s*\(/.test(lineText) ||
        /\bTemplate\s*\(\s*['"`].*\$\{|\bTemplate\s*\(\s*\w+/.test(lineText) ||
        /\bjinja2\.Template\s*\(/.test(lineText) ||
        /\bERB\.new\s*\(/.test(lineText) ||
        /\bTwig_Environment\b.*->createTemplate\s*\(/.test(lineText) ||
        /\bHandlebars\.compile\s*\(\s*\w+/.test(lineText)
      );
    },
  },
  {
    id: "ldap.injection",
    severity: "severe",
    title: "LDAP query built with concatenation",
    why: "Building LDAP filters with string concat lets attackers change the filter and bypass auth or dump directory data.",
    fix: "Escape LDAP filter special characters or use parameterized LDAP APIs. Never stitch raw user input into filters.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (!/\b(ldap|LDAP|DirContext|search\(.*objectClass)/i.test(lineText)) {
        return false;
      }
      return /\+|\$\{|%s|\.format\s*\(/.test(lineText);
    },
  },
  {
    id: "nosql.injection",
    severity: "severe",
    title: "Possible NoSQL injection ($where / operator injection)",
    why: "Passing user JSON into Mongo-like queries can inject operators ($gt, $where) and bypass filters or run JS in the DB.",
    fix: "Validate types, strip operator keys from user objects, and avoid $where. Use typed query builders.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\$where\b/.test(lineText) ||
        /\bfind\s*\(\s*\{[^}]*\$where/.test(lineText) ||
        /\b(req\.body|request\.json|params)\b.*\.(find|findOne|update|deleteOne)/i.test(
          lineText,
        )
      );
    },
  },
  {
    id: "crypto.weak-cipher",
    severity: "moderate",
    title: "Weak or obsolete cipher (DES/RC4/ECB)",
    why: "DES, RC4, and ECB mode are obsolete or leak patterns. Attackers can recover plaintext more easily.",
    fix: "Use AES-GCM or ChaCha20-Poly1305 with modern libraries and random IVs/nonces.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\b(DES|3DES|RC4|AES[/_\-]?ECB|ECB[/_\-]?AES)\b/i.test(lineText) ||
        /\bcreateCipher(iv)?\s*\(\s*['"][^'"]*ecb/i.test(lineText) ||
        /\bCipher\.getInstance\s*\(\s*['"][^'"]*ECB/i.test(lineText)
      );
    },
  },
  {
    id: "cookie.insecure-flags",
    severity: "moderate",
    title: "Cookie missing Secure or HttpOnly",
    why: "Cookies without HttpOnly are readable by XSS scripts; without Secure they can leak on plain HTTP.",
    fix: "Set HttpOnly, Secure, and SameSite appropriately for session cookies.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\b(httpOnly|HttpOnly)\s*:\s*false\b/.test(lineText) ||
        /\b(secure|Secure)\s*:\s*false\b/.test(lineText)
      );
    },
  },
  {
    id: "csrf.disabled",
    severity: "moderate",
    title: "CSRF protection disabled",
    why: "Turning off CSRF checks lets other sites trigger state-changing requests as your logged-in users.",
    fix: "Keep framework CSRF middleware on for cookie-based sessions. Use SameSite cookies and anti-CSRF tokens.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) && !CONFIG_LIKE.test(filePath)) return false;
      if (isCommentLine(lineText)) return false;
      return (
        /\bcsrf\s*[:=]\s*false\b/i.test(lineText) ||
        /\bCSRF_COOKIE_SECURE\s*=\s*False\b/.test(lineText) ||
        /\bprotect_from_forgery\s+[^\n]*except/i.test(lineText) ||
        /\bcsrfProtect\s*:\s*false\b/i.test(lineText) ||
        /\benableCsrfProtection\s*\(\s*false\s*\)/i.test(lineText) ||
        /\bverify_csrf\s*=\s*False\b/.test(lineText)
      );
    },
  },
  {
    id: "mass-assignment",
    severity: "moderate",
    title: "Possible mass assignment / unbound attrs",
    why: "Updating models from raw request params can let attackers set privileged fields (role, isAdmin, price).",
    fix: "Allow-list fields (strong params / serializers). Never pass entire request bodies into create/update.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /\bupdate_attributes\s*\(/.test(lineText) ||
        /\bpermit!\s*(\(|$)/.test(lineText) ||
        /\bparams\.permit!\b/.test(lineText) ||
        /\bObject\.assign\s*\(\s*\w+\s*,\s*req\.body/.test(lineText) ||
        /\b\.update\s*\(\s*req\.body\s*\)/.test(lineText) ||
        /\bsetattr\s*\(\s*\w+\s*,\s*request\.(POST|data|json)/.test(lineText)
      );
    },
  },
  {
    id: "proto.pollution",
    severity: "severe",
    title: "Prototype pollution sink (__proto__ / constructor.prototype)",
    why: "Writing to __proto__ or constructor.prototype can change behavior for all objects and escalate to RCE in some apps.",
    fix: "Block __proto__ and constructor keys when merging objects. Use Object.create(null) maps or hardened merge helpers.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      return (
        /__proto__/.test(lineText) ||
        /\bconstructor\s*\[|\bconstructor\.prototype\b/.test(lineText)
      );
    },
  },
  {
    id: "shell.eval-dynamic",
    severity: "severe",
    title: "Dynamic code execution (Perl/Lua/etc.)",
    why: "eval/loadstring/dostring on untrusted input is remote code execution in scripting languages.",
    fix: "Avoid dynamic execution. Parse data with safe parsers; use allow-listed commands instead of eval.",
    test(filePath, _line, lineText) {
      if (isCommentLine(lineText)) return false;
      if (PERL_LIKE.test(filePath)) {
        return /(^|[^\w])(eval|system|exec|qx)\s*[({]/.test(lineText);
      }
      if (LUA_LIKE.test(filePath)) {
        return /\b(loadstring|load)\s*\(/.test(lineText);
      }
      if (/\.(ex|exs)$/i.test(filePath)) {
        return /\bCode\.eval(_string|_quoted)?\s*\(/.test(lineText);
      }
      if (/\.r$/i.test(filePath)) {
        return /\beval\s*\(/.test(lineText);
      }
      return false;
    },
  },
  {
    id: "docker.privileged-or-secrets",
    severity: "moderate",
    title: "Docker privileged mode or secret in Dockerfile",
    why: "privileged containers weaken isolation. Hardcoded secrets in Dockerfiles end up in image layers forever.",
    fix: "Avoid --privileged. Pass secrets at runtime via orchestrator secrets, not ENV/ARG with real values.",
    test(filePath, _line, lineText) {
      const base = baseName(filePath).toLowerCase();
      const isDocker =
        base === "dockerfile" ||
        base === "containerfile" ||
        /\.ya?ml$/i.test(filePath);
      if (!isDocker || isCommentLine(lineText)) return false;
      return (
        /\bprivileged\s*:\s*true\b/i.test(lineText) ||
        /\b--privileged\b/.test(lineText) ||
        /\b(ENV|ARG)\s+[A-Z0-9_]*(SECRET|PASSWORD|TOKEN|API[_-]?KEY)[A-Z0-9_]*\s*=\s*\S+/i.test(
          lineText,
        )
      );
    },
  },
  {
    id: "infra.public-acl",
    severity: "moderate",
    title: "Cloud storage / ACL appears public",
    why: "Public-read buckets and 0.0.0.0/0 security groups commonly expose data or admin ports to the internet.",
    fix: "Default to private. Restrict CIDRs, use private endpoints, and audit public ACLs regularly.",
    test(filePath, _line, lineText) {
      if (isCommentLine(lineText)) return false;
      if (!/\.(tf|tfvars|hcl|yml|yaml|json)$/i.test(filePath)) return false;
      if (
        /\b(public-read|public-read-write|AllUsers)\b/i.test(lineText) ||
        /\bacl\s*=\s*['"]public/i.test(lineText)
      ) {
        return true;
      }
      if (/\b0\.0\.0\.0\/0\b/.test(lineText)) {
        return /\b(ingress|egress|cidr|security_group|firewall)\b/i.test(
          lineText,
        );
      }
      return false;
    },
  },
  {
    id: "auth.hardcoded-admin",
    severity: "severe",
    title: "Hardcoded admin/default credentials",
    why: "Default or hardcoded admin passwords are among the first things attackers try against public apps.",
    fix: "Force unique passwords at install, store hashes (not plaintext), and load credentials from a secret store.",
    test(filePath, _line, lineText) {
      if (isLockfile(filePath) || isCommentLine(lineText)) return false;
      if (!CODE_LIKE.test(filePath) && !CONFIG_LIKE.test(filePath)) return false;
      return (
        /\b(admin|root)\b.*=.*['"](admin|password|passw0rd|123456|root)['"]/i.test(
          lineText,
        ) ||
        /\bpassword\s*[:=]\s*['"](admin|password|passw0rd|123456|changeme)['"]/i.test(
          lineText,
        )
      );
    },
  },

  // ─── Mild / hygiene ───────────────────────────────────────────────
  {
    id: "mild.console-secret",
    severity: "mild",
    title: "Logging possible secrets to the console",
    why: "console.log of passwords/tokens often ends up in browser consoles or centralized logs — leaking credentials.",
    fix: "Never log secrets. Redact sensitive fields in log statements.",
    test(filePath, _line, lineText) {
      if (!JS_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (!/\bconsole\.(log|debug|info|warn|error)\s*\(/.test(lineText)) {
        return false;
      }
      return /\b(password|secret|token|api[_-]?key|authorization)\b/i.test(
        lineText,
      );
    },
  },
  {
    id: "mild.http-cleartext-url",
    severity: "mild",
    title: "http:// URL in code (cleartext)",
    why: "Plain HTTP can be intercepted or modified on the network. Prefer HTTPS for APIs and auth-related endpoints.",
    fix: "Use https:// URLs. Gate http:// behind development-only checks if needed for local work.",
    test(filePath, _line, lineText) {
      if (!CONFIG_LIKE.test(filePath) || isCommentLine(lineText)) return false;
      if (isLockfile(filePath)) return false;
      if (/https?:\/\/(localhost|127\.0\.0\.1)/i.test(lineText)) return false;
      return /['"`]http:\/\/[^\s'"`]+['"`]/.test(lineText);
    },
  },
  {
    id: "mild.security-todo",
    severity: "mild",
    title: "Security-related TODO/FIXME",
    why: "TODO/FIXME comments that mention security often mark known unfinished hardening. Worth tracking, not an exploit by itself.",
    fix: "Triage the comment: fix the issue, open a tracked ticket, or remove outdated notes.",
    test(filePath, _line, lineText) {
      if (!CODE_LIKE.test(filePath) && !CONFIG_LIKE.test(filePath)) return false;
      return /\b(TODO|FIXME|XXX|HACK)\b.*\b(security|vulnerab|auth|xss|inject|csrf|crypto)\b/i.test(
        lineText,
      );
    },
  },
];

/**
 * Run all rules against one line of a file.
 * @returns {RuleHit[]}
 */
export function matchLine(filePath, lineNumber, lineText) {
  /** @type {RuleHit[]} */
  const hits = [];
  for (const rule of RULES) {
    try {
      if (rule.test(filePath, lineNumber, lineText)) {
        hits.push({
          ruleId: rule.id,
          severity: rule.severity,
          title: rule.title,
          why: rule.why,
          fix: rule.fix,
        });
      }
    } catch {
      // A bad regex on one line should not abort the whole scan.
    }
  }
  return hits;
}
