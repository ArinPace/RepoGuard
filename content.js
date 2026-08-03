/**
 * RepoGuard content script (classic IIFE — no ES modules).
 * Discovers file/folder paths on the GitHub code browser for the side panel.
 * Does not inject a floating UI.
 */
(function () {
  function isExtensionContextValid() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function isContextInvalidatedError(error) {
    const msg = String(error?.message || error || "");
    return msg.includes("Extension context invalidated");
  }

  if (window.__REPOGUARD_CONTENT__) {
    if (isExtensionContextValid() && window.__REPOGUARD_API__) {
      return;
    }
    try {
      window.__REPOGUARD_API__?.destroy?.();
    } catch {
      /* ignore */
    }
    window.__REPOGUARD_CONTENT__ = false;
    window.__REPOGUARD_API__ = null;
  }
  window.__REPOGUARD_CONTENT__ = true;

  const CONTEXT_DEAD_MSG =
    "Extension was reloaded. Refresh this GitHub tab, then open the RepoGuard side panel again.";

  let destroyed = false;
  let messageListener = null;
  let lastHref = location.href;
  let popstateListener = null;

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try {
      if (messageListener) chrome.runtime.onMessage.removeListener(messageListener);
    } catch {
      /* ignore */
    }
    if (popstateListener) {
      window.removeEventListener("popstate", popstateListener);
    }
    window.__REPOGUARD_CONTENT__ = false;
    window.__REPOGUARD_API__ = null;
  }

  function parseRepoFromLocation() {
    try {
      const url = new URL(location.href);
      if (url.hostname !== "github.com" && url.hostname !== "www.github.com") {
        return null;
      }
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      const reserved = new Set([
        "settings",
        "notifications",
        "marketplace",
        "explore",
        "topics",
        "login",
        "signup",
        "orgs",
        "organizations",
        "search",
        "pulls",
        "issues",
      ]);
      if (reserved.has(parts[0].toLowerCase())) return null;
      return { owner: parts[0], repo: parts[1].replace(/\.git$/i, "") };
    } catch {
      return null;
    }
  }

  function isCodeBrowserPage() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return false;
    if (parts.length === 2) return true;
    return parts[2] === "tree";
  }

  function pathFromGitHubHref(href, owner, repo) {
    let url;
    try {
      url = new URL(href, location.origin);
    } catch {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 4) return null;
    if (parts[0] !== owner || parts[1] !== repo) return null;
    const kindSeg = parts[2];
    if (kindSeg !== "blob" && kindSeg !== "tree") return null;
    const pathParts = parts.slice(4);
    if (pathParts.length === 0) return null;
    const path = pathParts
      .map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          return p;
        }
      })
      .join("/");
    return {
      kind: kindSeg === "tree" ? "folder" : "file",
      path,
    };
  }

  function discoverEntries(owner, repo) {
    const found = new Map();
    const anchors = document.querySelectorAll(
      `a[href*="/${owner}/${repo}/blob/"], a[href*="/${owner}/${repo}/tree/"]`,
    );

    for (const link of anchors) {
      if (!(link instanceof HTMLAnchorElement)) continue;
      if (link.closest("nav, header, footer, [hidden], template")) continue;
      if (link.closest(".AppHeader, .UnderlineNav, .js-repo-nav")) continue;
      if (link.closest('[aria-label="Breadcrumb"], [data-testid="breadcrumbs"]')) {
        continue;
      }

      const parsed = pathFromGitHubHref(
        link.getAttribute("href") || link.href,
        owner,
        repo,
      );
      if (!parsed?.path) continue;

      const inMain = link.closest(
        "#repo-content-turbo-frame, #repo-content-pjax-container, [data-hpc], main, [aria-labelledby='folders-and-files'], [role='grid']",
      );
      if (!inMain) continue;

      try {
        const style = window.getComputedStyle(link);
        if (style.display === "none" || style.visibility === "hidden") continue;
      } catch {
        /* ignore */
      }

      const key = `${parsed.kind}:${parsed.path}`;
      if (found.has(key)) continue;
      found.set(key, parsed);
    }

    return [...found.values()].sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.path.localeCompare(b.path);
    });
  }

  function listEntriesPayload() {
    if (!isExtensionContextValid()) {
      destroy();
      return { ok: false, error: CONTEXT_DEAD_MSG };
    }
    const parsed = parseRepoFromLocation();
    if (!parsed) {
      return {
        ok: false,
        error: "Open a GitHub repository code page (owner/repo).",
        onCodePage: false,
      };
    }
    const onCodePage = isCodeBrowserPage();
    const entries = onCodePage
      ? discoverEntries(parsed.owner, parsed.repo)
      : [];
    return {
      ok: true,
      owner: parsed.owner,
      repo: parsed.repo,
      onCodePage,
      href: location.href,
      entries,
      count: entries.length,
    };
  }

  messageListener = (message, _sender, sendResponse) => {
    if (destroyed || !message || typeof message !== "object") return;

    if (!isExtensionContextValid()) {
      destroy();
      sendResponse({ ok: false, error: CONTEXT_DEAD_MSG });
      return false;
    }

    if (message.type === "RG_LIST_ENTRIES" || message.type === "RG_PING") {
      try {
        sendResponse(listEntriesPayload());
      } catch (error) {
        sendResponse({
          ok: false,
          error: isContextInvalidatedError(error)
            ? CONTEXT_DEAD_MSG
            : String(error?.message || error),
        });
      }
      return false;
    }
  };
  chrome.runtime.onMessage.addListener(messageListener);

  const origPush = history.pushState;
  const origReplace = history.replaceState;
  history.pushState = function (...args) {
    origPush.apply(this, args);
    lastHref = location.href;
  };
  history.replaceState = function (...args) {
    origReplace.apply(this, args);
    lastHref = location.href;
  };
  popstateListener = () => {
    lastHref = location.href;
  };
  window.addEventListener("popstate", popstateListener);

  window.__REPOGUARD_API__ = { destroy };
})();
