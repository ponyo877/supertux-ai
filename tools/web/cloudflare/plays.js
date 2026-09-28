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

// What worker.js and tools/jev-proxy/server.mjs share about reported plays.
//
// Every start of the level asks for a token (POST /api/session), which is
// when the attempt is counted. The token says the mode and when it was
// given, signed with the server's secret, so the server keeps nothing until
// it is used. A death or a clear is then reported with the token and the
// path of the attempt (POST /api/stats); it counts only if the token is
// good, has not been used for that already, is at least as old as the path
// is long (a recorded path sent again still takes the time of playing it),
// and the path passes verify.js.

import { verify } from "./verify.js";

export const MODES = new Set(["off", "coevo6", "coevo5", "coevo4", "coevo3", "coevo2", "coevo", "rl2", "rl", "llm", "laya-rich", "laya"]);
export const TOKEN_LIFE_MS = 60 * 60 * 1000;
export const MAX_BODY = 512 * 1024;
const CLOCK_SLACK_MS = 3000;  // the token comes a moment after the path starts

const encoder = new TextEncoder();
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function sign(secret, text) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" },
                                            false, ["sign"]);
  return base64url(await crypto.subtle.sign("HMAC", key, encoder.encode(text)));
}

/** A new token for an attempt in this mode. */
export async function makeToken(secret, mode, now = Date.now()) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(9)));
  const body = `${mode}.${now}.${nonce}`;
  return `${body}.${await sign(secret, body)}`;
}

/** { mode, issued, id } if the token is one of ours, else null. id is what
    is kept once it is used: a hash, not the token. */
async function readToken(secret, token) {
  if (typeof token !== "string" || token.length > 200)
    return null;
  const parts = token.split(".");
  if (parts.length !== 4)
    return null;
  const [mode, issued, nonce, signature] = parts;
  const expected = await sign(secret, `${mode}.${issued}.${nonce}`);
  if (expected.length !== signature.length)
    return null;
  let difference = 0;
  for (let i = 0; i < expected.length; i++)
    difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (difference !== 0 || !MODES.has(mode) || !/^\d+$/.test(issued))
    return null;
  const id = base64url(await crypto.subtle.digest("SHA-256", encoder.encode(token))).slice(0, 22);
  return { mode, issued: Number(issued), id };
}

/**
 * Checks a reported death or clear. Returns { ok: true, mode, kind, id,
 * x, y, expires } to count (id and kind: to note the token as used), or
 * { ok: false, mode?, reason } not to.
 */
export async function checkReport(secret, map, text, now = Date.now()) {
  let report;
  try { report = JSON.parse(text); } catch { return { ok: false, reason: "json" }; }
  const { token, kind, path, at } = report || {};
  if (kind !== "death" && kind !== "clear")
    return { ok: false, reason: "kind" };
  const t = await readToken(secret, token);
  if (!t)
    return { ok: false, reason: "token" };
  const fail = (reason) => ({ ok: false, mode: t.mode, reason });
  if (now - t.issued > TOKEN_LIFE_MS || t.issued > now + CLOCK_SLACK_MS)
    return fail("expired");
  const result = verify(kind, path, at, map);
  if (!result.ok)
    return fail(result.reason);
  const duration = path[path.length - 1][0];
  if (now - t.issued < duration - CLOCK_SLACK_MS)
    return fail("too early");
  const last = path[path.length - 1];
  return { ok: true, mode: t.mode, kind, id: t.id, x: last[1], y: last[2], expires: t.issued + TOKEN_LIFE_MS };
}
