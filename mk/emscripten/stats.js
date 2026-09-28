//  SuperTux
//  Copyright (C) 2026 ponyo877
//
//  This program is free software: you can redistribute it and/or modify
//  it under the terms of the GNU General Public License as published by
//  the Free Software Foundation, either version 3 of the License, or
//  (at your option) any later version.
//
//  This program is distributed in the hope that it will be useful,
//  but WITHOUT ANY WARRANTY; without even the implied warranty of
//  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
//  GNU General Public License for more details.
//
//  You should have received a copy of the GNU General Public License
//  along with this program.  If not, see <http://www.gnu.org/licenses/>.

// Everyone's plays of this mode: how many attempts, deaths and clears there
// have been, shown at the top of the screen, and headstones in the level
// where players died, fainter where fewer did, so the dangerous spots show.
// The headstone is OpenMoji's (headstone.png, by Liz Bravo, CC BY-SA 4.0);
// it is written into the game's data directory here rather than shipped in
// the data package, which players already have.
//
// The game reports what happens through window.jev_on_event (see
// src/port/jev_bridge.cpp). Every start of the level is an attempt (there
// are no checkpoints in this version) and asks the server for a token; a
// death or a clear is sent with that token and the path Tux took since the
// start, which the server checks before counting it
// (tools/web/cloudflare/plays.js, verify.js). The server
// (tools/web/cloudflare/worker.js, or tools/jev-proxy/server.mjs locally)
// keeps only counts: per mode, and per tile for the deaths. Automated play
// (tools/eval, tools/rl, tools/coevo) runs in this page too but is not
// counted.

(function () {
  "use strict";

  const REFRESH_MS = 60000;
  const params = new URLSearchParams(location.search);
  const mode = params.get("ai") || "off";
  const LABELS = { off: "Classic", coevo6: "Trained AI", coevo5: "Trained AI (earlier)", coevo4: "Trained AI (first)", "laya-rich": "Laya AI" };
  const label = LABELS[mode] || mode;

  let server = { attempts: 0, deaths: 0, clears: 0 };
  let pending = { attempts: 0, deaths: 0, clears: 0 };  // since the last answer
  let loaded = false;
  let tile = 32;
  const marks = new Map();  // "tx ty" -> deaths
  let marksShown = false;

  const counting = () => !window.jev_inline;

  // --- the counts -----------------------------------------------------------

  const box = document.createElement("div");
  box.id = "stats_box";
  box.style.cssText =
    "position:fixed;left:50%;top:6px;transform:translateX(-50%);z-index:10;padding:3px 10px;" +
    "font:12px/1.4 system-ui,sans-serif;color:#fff;background:#0009;border-radius:10px;" +
    "pointer-events:none;white-space:nowrap;display:none";
  const format = (n) => n.toLocaleString("en-US");
  function show() {
    if (!loaded)
      return;
    const total = (kind) => server[kind] + pending[kind];
    box.textContent = `Everyone, ${label}: ${format(total("attempts"))} tries · ` +
                      `${format(total("deaths"))} deaths · ${format(total("clears"))} clears`;
    box.style.display = "";
  }
  window.addEventListener("DOMContentLoaded", () => document.body.appendChild(box));

  let token = null;  // a promise of this attempt's token

  function startAttempt() {
    token = fetch("api/session", { method: "POST", body: JSON.stringify({ mode }) })
      .then((response) => response.ok ? response.json() : null)
      .then((answer) => answer && answer.token)
      .catch(() => null);
  }

  /** Sends a death or a clear with this attempt's path; true if it counted. */
  async function report(kind, at) {
    if (!token || typeof Module === "undefined" || !Module._jev_take_trajectory)
      return false;
    const path = JSON.parse(Module.UTF8ToString(Module._jev_take_trajectory()));
    const attempt = await token;
    if (!attempt)
      return false;
    const body = JSON.stringify({ token: attempt, kind, path, at });
    try {
      const response = await fetch("api/stats", { method: "POST", body, keepalive: body.length < 60000,
                                                  headers: { "Content-Type": "application/json" } });
      return response.ok;
    } catch (error) {
      return false;
    }
  }

  // --- the marks ------------------------------------------------------------

  /** Puts the headstone where the game looks for it, once the game runs. */
  async function giveIcon() {
    try {
      const bytes = new Uint8Array(await (await fetch("headstone.png")).arrayBuffer());
      (function write() {
        const dir = typeof Module !== "undefined" && Module._jev_data_dir && Module.UTF8ToString
                    ? Module.UTF8ToString(Module._jev_data_dir()) : "";
        if (!dir || typeof FS === "undefined")
          return setTimeout(write, 1000);
        FS.writeFile(dir.replace(/\/$/, "") + "/images/engine/death-mark.png", bytes);
        Module._jev_death_icon_written();
      })();
    } catch (error) {
      // Round marks then.
    }
  }
  giveIcon();

  /** Hands the marks to the game, once it runs. */
  function showMarks() {
    if (marksShown || !marks.size)
      return;
    if (typeof Module === "undefined" || !Module._jev_set_death_marks || !Module.HEAPF32) {
      setTimeout(showMarks, 1000);
      return;
    }
    const most = Math.max(...marks.values());
    const data = new Float32Array(marks.size * 3);
    let i = 0;
    for (const [key, n] of marks) {
      const [tx, ty] = key.split(" ").map(Number);
      data[i++] = (tx + 0.5) * tile;
      data[i++] = (ty + 0.5) * tile;
      data[i++] = most > 1 ? Math.log(n) / Math.log(most) : 1;
    }
    const pointer = Module._malloc(data.byteLength);
    Module.HEAPF32.set(data, pointer >> 2);
    Module._jev_set_death_marks(pointer, marks.size);
    Module._free(pointer);
    marksShown = true;
  }

  async function refresh() {
    try {
      const response = await fetch(`api/stats?mode=${encodeURIComponent(mode)}`, { cache: "no-store" });
      if (response.ok) {
        const data = await response.json();
        server = { attempts: data.attempts, deaths: data.deaths, clears: data.clears };
        pending = { attempts: 0, deaths: 0, clears: 0 };
        tile = data.tile || 32;
        marks.clear();
        for (const [tx, ty, n] of data.marks)
          marks.set(`${tx} ${ty}`, n);
        marksShown = false;
        loaded = true;
        show();
        showMarks();
      }
    } catch (error) {
      // No counts then; the game plays on.
    }
    setTimeout(refresh, REFRESH_MS);
  }
  refresh();

  // --- what the game reports ------------------------------------------------

  const previous = window.jev_on_event;
  window.jev_on_event = function (json) {
    if (counting()) {
      try {
        const e = JSON.parse(json);
        if (e.type === "restart") {
          pending.attempts++;
          startAttempt();
        } else if (e.type === "player_death") {
          const key = `${Math.floor(e.x / tile)} ${Math.floor(e.y / tile)}`;
          report("death", [Math.round(e.x), Math.round(e.y)]).then((counted) => {
            if (!counted)
              return;
            pending.deaths++;
            marks.set(key, (marks.get(key) || 0) + 1);
            marksShown = false;
            showMarks();
            show();
          });
        } else if (e.type === "level_finished" && e.detail === "win") {
          report("clear", null).then((counted) => {
            if (counted) {
              pending.clears++;
              show();
            }
          });
        }
        show();
      } catch (error) {
        // A malformed event is not worth stopping the game for.
      }
    }
    if (previous)
      previous(json);
  };
})();
