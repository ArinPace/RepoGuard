// Shared language / extension support for fetching and rule gating.

/** Extensions we download and scan (lowercase, including the dot). */
export const CODE_EXTENSIONS = new Set([
  // JavaScript / TypeScript / web
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".vue",
  ".svelte",
  ".astro",
  ".coffee",
  ".html",
  ".htm",
  ".ejs",
  ".hbs",
  ".njk",
  ".pug",
  ".twig",
  ".erb",
  ".haml",
  ".jinja",
  ".jinja2",
  ".j2",

  // Python
  ".py",
  ".pyw",
  ".pyi",
  ".ipynb",

  // JVM
  ".java",
  ".kt",
  ".kts",
  ".scala",
  ".sc",
  ".groovy",
  ".gradle",
  ".clj",
  ".cljs",
  ".cljc",

  // Systems / native
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".hxx",
  ".hh",
  ".rs",
  ".go",
  ".zig",
  ".nim",
  ".m",
  ".mm",
  ".swift",

  // .NET
  ".cs",
  ".fs",
  ".fsx",
  ".vb",
  ".cshtml",
  ".vbhtml",
  ".aspx",
  ".razor",

  // Scripting / dynamic
  ".rb",
  ".rake",
  ".php",
  ".phtml",
  ".pl",
  ".pm",
  ".lua",
  ".r",
  ".jl", // Julia
  ".ex",
  ".exs",
  ".erl",
  ".hrl",
  ".hs",
  ".lhs",
  ".ml",
  ".mli",
  ".cr", // Crystal
  ".dart",
  ".sol", // Solidity

  // Shell / automation
  ".sh",
  ".bash",
  ".zsh",
  ".fish",
  ".ps1",
  ".psm1",
  ".bat",
  ".cmd",

  // Data / config (secrets & misconfig often live here)
  ".json",
  ".jsonc",
  ".json5",
  ".yml",
  ".yaml",
  ".toml",
  ".xml",
  ".ini",
  ".cfg",
  ".conf",
  ".properties",
  ".env",
  ".sql",
  ".tf",
  ".tfvars",
  ".hcl",
]);

/** Basenames with no/odd extensions that are still worth scanning. */
export const SCANNABLE_BASENAMES = new Set([
  "dockerfile",
  "containerfile",
  "makefile",
  "gnumakefile",
  "procfile",
  "gemfile",
  "rakefile",
  "podfile",
  "vagrantfile",
  "brewfile",
  "pipfile",
]);

export function extensionOf(filePath) {
  const base = filePath.split("/").pop() || "";
  const lower = base.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot === -1) return "";
  return lower.slice(dot);
}

export function isScannablePath(filePath) {
  const base = (filePath.split("/").pop() || "").toLowerCase();
  if (base.startsWith(".env")) return true;
  if (SCANNABLE_BASENAMES.has(base)) return true;
  // Gemfile.lock etc. handled as lockfiles elsewhere; still "scannable" type-wise but rules skip
  return CODE_EXTENSIONS.has(extensionOf(filePath));
}

/** Regex helpers for rule gating (keep in sync with CODE_EXTENSIONS). */
export const JS_LIKE =
  /\.(js|jsx|mjs|cjs|ts|tsx|vue|svelte|astro|coffee|ejs|hbs)$/i;
export const PY_LIKE = /\.(py|pyw|pyi)$/i;
export const RUBY_LIKE = /\.(rb|rake|erb)$/i;
export const PHP_LIKE = /\.(php|phtml)$/i;
export const GO_LIKE = /\.go$/i;
export const JAVA_LIKE = /\.(java|kt|kts|scala|sc|groovy)$/i;
export const RUST_LIKE = /\.rs$/i;
export const CSHARP_LIKE = /\.(cs|cshtml|razor)$/i;
export const C_LIKE = /\.(c|h|cpp|cc|cxx|hpp|hxx|hh)$/i;
export const PERL_LIKE = /\.(pl|pm)$/i;
export const LUA_LIKE = /\.lua$/i;
export const HTML_LIKE = /\.(html|htm|vue|svelte|astro|ejs|hbs|njk|pug|twig|erb|haml|jinja|jinja2|j2)$/i;
export const SHELL_LIKE = /\.(sh|bash|zsh|fish|ps1|psm1)$/i;
export const YAML_LIKE = /\.(yml|yaml)$/i;
export const SQL_LIKE = /\.sql$/i;

export const CODE_LIKE =
  /\.(js|jsx|mjs|cjs|ts|tsx|vue|svelte|astro|coffee|py|pyw|java|kt|kts|scala|groovy|go|rb|rake|php|phtml|cs|fs|rs|c|cpp|cc|cxx|h|hpp|swift|m|mm|pl|pm|lua|r|ex|exs|dart|sol|zig|nim|jl|cr|hs|ml|clj|cljs|erb|ejs)$/i;

export const CONFIG_LIKE =
  /\.(js|jsx|mjs|cjs|ts|tsx|vue|svelte|json|jsonc|yml|yaml|toml|xml|ini|cfg|conf|properties|env|py|php|rb|java|kt|go|cs|rs|html|htm|tf|tfvars|hcl|sql|sh|bash|ps1|gradle|Dockerfile)$/i;

export function scannableExtensionList() {
  return [...CODE_EXTENSIONS].sort().join(", ");
}
