/* Uniform auto-update system — see updates/UPDATES_SPEC.md
 * Vanilla JS: release check + top-center ribbon + Settings Updates section.
 * LIVE in this repo (web app): loaded by apps/web/index.html; renders into #updates-section at the bottom of the web Settings view and shows the ribbon.
 */
(function () {
  "use strict";
  var GITHUB_REPO = "marcusdhaynes/Calypso";
  var CURRENT_VERSION = "0.2.0"; // root + apps/web package.json
  var DISMISS_KEY = "updates:dismissed:";

  function parseSemver(v) { return String(v).replace(/^v/i, "").split(".").map(function (n) { return parseInt(n, 10) || 0; }); }
  function compareSemver(a, b) {
    var pa = parseSemver(a), pb = parseSemver(b);
    for (var i = 0; i < Math.max(pa.length, pb.length); i++) { var d = (pa[i] || 0) - (pb[i] || 0); if (d !== 0) return d; }
    return 0;
  }
  function fetchLatestRelease() {
    return fetch("https://api.github.com/repos/" + GITHUB_REPO + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !d.tag_name) return null;
        return { version: String(d.tag_name).replace(/^v/i, ""), tag: String(d.tag_name), notes: d.body || "", url: d.html_url || ("https://github.com/" + GITHUB_REPO + "/releases") };
      })
      .catch(function () { return null; });
  }
  function isDismissed(v) { try { return localStorage.getItem(DISMISS_KEY + v) === "1"; } catch (e) { return false; } }
  function dismissVersion(v) { try { localStorage.setItem(DISMISS_KEY + v, "1"); } catch (e) {} }
  function applyUpdate(release) {
    if (/^https?:$/.test(window.location.protocol)) { window.location.reload(); return; }
    window.open(release.url, "_blank", "noopener");
  }

  function showRibbon(release) {
    if (isDismissed(release.version) || document.getElementById("update-ribbon")) return;
    var bar = document.createElement("div");
    bar.id = "update-ribbon";
    bar.setAttribute("role", "button");
    bar.style.cssText = "position:fixed;top:8px;left:50%;transform:translateX(-50%);z-index:9999;display:flex;align-items:center;gap:8px;max-width:92vw;padding:3px 6px 3px 12px;border-radius:999px;font:inherit;font-size:12.5px;line-height:1.5;cursor:pointer;background:rgba(127,127,127,.16);border:1px solid rgba(127,127,127,.35);backdrop-filter:blur(6px)";
    var label = document.createElement("span");
    label.textContent = "Update available · " + release.tag;
    var x = document.createElement("button");
    x.type = "button"; x.textContent = "×"; x.setAttribute("aria-label", "Dismiss this update");
    x.style.cssText = "background:none;border:none;color:inherit;cursor:pointer;font-size:13px;padding:0 4px;line-height:1";
    x.addEventListener("click", function (e) { e.stopPropagation(); dismissVersion(release.version); bar.remove(); });
    bar.appendChild(label); bar.appendChild(x);
    bar.addEventListener("click", function () { applyUpdate(release); });
    document.body.appendChild(bar);
  }

  function renderSection(container, latest, state) {
    if (!container) return;
    container.innerHTML = "";
    var h = document.createElement("h2"); h.textContent = "Updates"; container.appendChild(h);
    var cur = document.createElement("p"); cur.textContent = "Current version: " + CURRENT_VERSION; container.appendChild(cur);
    var av = document.createElement("p"); av.textContent = "Available version: " + (latest ? latest.tag : state === "checking" ? "Checking…" : "—"); container.appendChild(av);
    if (latest && compareSemver(latest.version, CURRENT_VERSION) > 0) {
      if (latest.notes) {
        var wh = document.createElement("h3"); wh.textContent = "What's New"; container.appendChild(wh);
        var pre = document.createElement("pre"); pre.style.whiteSpace = "pre-wrap"; pre.textContent = latest.notes; container.appendChild(pre);
      }
      var up = document.createElement("button"); up.type = "button"; up.textContent = "Update";
      up.addEventListener("click", function () { applyUpdate(latest); }); container.appendChild(up);
    } else if (state === "uptodate") {
      var p = document.createElement("p"); p.textContent = "You're up to date."; container.appendChild(p);
    } else if (state === "error") {
      var e2 = document.createElement("p"); e2.textContent = "Couldn't check for updates. Try again later."; container.appendChild(e2);
    }
    var chk = document.createElement("button"); chk.type = "button"; chk.textContent = "Check for updates";
    chk.addEventListener("click", function () { check(renderSection.bind(null, container)); });
    container.appendChild(chk);
  }

  function check(onSection) {
    fetchLatestRelease().then(function (latest) {
      if (!latest) { if (onSection) onSection(null, "error"); return; }
      var newer = compareSemver(latest.version, CURRENT_VERSION) > 0;
      if (newer) showRibbon(latest);
      if (onSection) onSection(latest, newer ? "idle" : "uptodate");
    });
  }

  window.AppUpdates = { check: check, fetchLatestRelease: fetchLatestRelease, compareSemver: compareSemver, CURRENT_VERSION: CURRENT_VERSION, GITHUB_REPO: GITHUB_REPO };

  function init() {
    var container = document.getElementById("updates-section");
    check(container ? function (latest, state) { renderSection(container, latest, state); } : null);
    if (!container && window.MutationObserver) {
      var obs = new MutationObserver(function () {
        var c = document.getElementById("updates-section");
        if (c && !c.dataset.rendered) {
          c.dataset.rendered = "1";
          fetchLatestRelease().then(function (latest) {
            if (!latest) { renderSection(c, null, "error"); return; }
            renderSection(c, latest, compareSemver(latest.version, CURRENT_VERSION) > 0 ? "idle" : "uptodate");
          });
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
