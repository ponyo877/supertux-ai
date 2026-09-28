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

// Teaches a learned model of Tux (fit_tux.py) only from ways through the
// level that were played to the end, one for every run it learns from.
//
//   node tools/coevo/tux-expert.mjs --teacher <table> --name <model> [--ai off,coevo5,table:<badguy>,...]
//        [--noisy coevo5] [--noise-seeds 1,...] [--delays 0,1,2,3] [--heldout-ai coevo5] [--heldout-delays 4,5]
//        [--heldout-noise-seeds 21,...] [--iterations 30] [--turbo 80] [--react 1]
//
// tux-model.mjs learned from everything search found past a failure, and
// from a table's moves: moves that got a little further, or that were
// wrong, in situations that look alike, and the model learned an average of
// them. Here every run keeps one way through, a list of moves that plays
// out the same every time: at first the teacher's moves; then, every
// iteration, where it fails a beam search finds a way on and the model
// plays on from there, and the whole list is played again. A run whose way
// gets to the goal is solved. The model is fit anew each time only from
// what the runs' ways saw and did: all of a solved run's, a failing run's
// up to a little before it fails. Runs never learned from (--heldout-...)
// tell how well it has learned to play; the best on those is kept, in
// tables/<name>.json.
//
// Needs the web build, tools/jev-proxy/server.mjs on 8765 and the uv
// environment of tools/distill.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const build = join(repo, "build.wasm");
const tablesDir = join(here, "tables");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
const list = (value, fallback = "") => (value || fallback).split(",").filter(Boolean);
const ais = list(args.ai, "off,coevo5");
const noisyAis = list(args.noisy);
const noise = Number(args.noise || 0.03);
const ITERATIONS = Number(args.iterations || 30);
const TURBO = Number(args.turbo || 80);
const BEAM = Number(args.beam || 12);
const DEPTH = Number(args.depth || 8);
const REACT = !!args.react;
const GOAL = 13380;
const AHEAD = 400;            // px past a failure a way on has to get
const BACK_OFF = [3, 6, 10];  // moves given back before a failure
const TAIL = 6;               // a failing way's last moves, not learned from
const MOVES = 9;
const CELL = 24;

const casesOf = (aisList, delaysList, noisySeeds) => [
  ...aisList.flatMap((ai) => delaysList.map((delay) => ({ ai, delay: Number(delay), seed: 1 }))),
  ...noisyAis.flatMap((ai) => noisySeeds.map((seed) => ({ ai: ai + "~", delay: 0, seed: Number(seed) }))),
];
const cases = casesOf(ais, list(args.delays, "0,1,2,3"), list(args["noise-seeds"], "1,2,3"));
const heldout = casesOf(list(args["heldout-ai"]), list(args["heldout-delays"]), list(args["heldout-noise-seeds"]));
const pageKinds = [...ais, ...noisyAis.map((ai) => ai + "~")];
const label = (c) => `${c.ai}${c.delay ? "+" + c.delay : ""}${c.ai.endsWith("~") ? "/" + c.seed : ""}`;

// --- pages ------------------------------------------------------------------

const play = await readFile(join(build, "play.html"), "utf8");
const marker = /<script src="laya-prompt\.js[^"]*"><\/script>/;
const STATS_SCRIPT = /<script src="stats\.js[^"]*"><\/script>/;
await copyFile(join(here, "player-facts.js"), join(build, "coevo-player-facts.js"));
await copyFile(join(here, "search.js"), join(build, "coevo-search.js"));
const v = Date.now();
await writeFile(join(build, "search.html"), play.replace(STATS_SCRIPT, "").replace(marker, (m) =>
  `<script src="coevo-player-facts.js?v=${v}"></script>\n  <script src="coevo-search.js?v=${v}"></script>\n  ${m}`));

async function aiQuery(kind) {
  const ai = kind.replace(/~$/, "");
  const extra = kind.endsWith("~") ? `&noise=${noise}` : "";
  if (!ai.startsWith("table:")) return `ai=${ai}${extra}`;
  const name = ai.slice(6);
  await copyFile(join(tablesDir, `${name}.js`), join(build, `${name}-table.js`));
  return `ai=table&table=${encodeURIComponent(name)}${extra}`;
}

const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--mute-audio"] });
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const pages = {};
for (const kind of pageKinds) {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto(`http://127.0.0.1:8765/search.html?${await aiQuery(kind)}&v=${v}`, { timeout: 300000 });
  await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { window.__search_features = true; return window.__search_ready(); });
  pages[kind] = page;
}

/** One run: its waits and `moves`, then `policy` (a table or a model) if
    given. The result's pairs are those after the waits. */
async function run(c, moves, policy = null) {
  const waits = Array(c.delay).fill(2);
  const r = await pages[c.ai].evaluate(([waits, moves, policy, seed, turbo, react, goal]) =>
    policy ? window.__search_policy(112, 576, goal, [...waits, ...moves], policy, turbo, seed, 300)
           : window.__search_try(112, 576, goal, [...waits, ...moves], 0, turbo, seed, null, 300, null, react),
  [waits, moves, policy, c.seed, TURBO, REACT, GOAL]);
  return { ...r, pairs: r.pairs.slice(waits.length) };
}

/** Beam search after `prefix` for moves that get past `goal` alive. */
async function searchFrom(c, prefix, goal) {
  let beam = [[]];
  for (let depth = 1; depth <= DEPTH && beam.length; depth++) {
    const ends = new Map();
    for (const s of beam.flatMap((s) => Array.from({ length: MOVES }, (_, m) => [...s, m]))) {
      const r = await run(c, [...prefix, ...s]);
      if (r.alive && (r.reached || r.x >= goal)) return s;
      if (!r.alive) continue;
      const key = `${Math.round(r.x / CELL)} ${Math.round(r.y / CELL)} ${r.ground}`;
      const score = r.x + 0.8 * (576 - r.y);
      if (!ends.has(key) || ends.get(key).score < score) ends.set(key, { score, seq: s });
    }
    beam = [...ends.values()].sort((a, b) => b.score - a.score).slice(0, BEAM).map((e) => e.seq);
  }
  return null;
}

/** Plays every run with a policy; results in the order of `list`. */
async function playAll(list, policy) {
  const out = new Array(list.length);
  await Promise.all(pageKinds.map(async (kind) => {
    for (let i = 0; i < list.length; i++)
      if (list[i].ai === kind) out[i] = await run(list[i], [], policy);
  }));
  return out;
}

const far = (r) => (r.reached ? GOAL + 1000 : r.maxX);
const show = (list, results) => list.map((c, i) => `${label(c)} ${results[i].reached ? "GOAL" : results[i].maxX}`).join(", ");
const goals = (results) => results.filter((r) => r.reached).length;

// --- the ways through -------------------------------------------------------------

const parse = (text) => JSON.parse(text.slice(text.indexOf("] = ") + 4, text.lastIndexOf(";")));
const teacher = parse(await readFile(join(tablesDir, `${args.teacher}.js`), "utf8"));
const teacherPolicy = { packed: teacher.packed, extra: teacher.extra, delta: teacher.delta || {}, react: !!teacher.react };
// Every run's way: moves, and how it played out.
const ways = (await playAll(cases, teacherPolicy)).map((r) => ({ moves: r.pairs.map((p) => p[1]), result: r }));
console.log(`teacher ${args.teacher}: ${show(cases, ways.map((w) => w.result))} (${goals(ways.map((w) => w.result))}/${cases.length})`);

const FEATURES = vm.runInNewContext((await readFile(join(here, "player-facts.js"), "utf8")) + "; PlayerFacts.FEATURES", {});
const demosPath = join(here, `demos-${args.name}.json`);
const modelPath = join(here, `fit-${args.name}.json`);
let best = null;
let model = null;

for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
  // 1. Every failing way goes on: search past where it fails, then the model
  //    (once there is one) plays on; the whole way is played again.
  await Promise.all(pageKinds.map(async (kind) => {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i], way = ways[i];
      if (c.ai !== kind || way.result.reached) continue;
      const r = way.result;
      const reachedAt = r.pairs.findIndex((p) => p[2] >= r.maxX - 48);
      const upTo = reachedAt < 0 ? way.moves.length : reachedAt + 1;
      for (const back of BACK_OFF) {
        if (upTo - back < 0) continue;
        const prefix = way.moves.slice(0, upTo - back);
        const found = await searchFrom(c, prefix, Math.min(GOAL, r.maxX + AHEAD));
        if (!found) continue;
        const played = await run(c, [...prefix, ...found], model);
        if (far(played) > far(r)) {
          ways[i] = { moves: played.pairs.map((p) => p[1]), result: played };
          break;
        }
      }
    }
  }));
  const solved = goals(ways.map((w) => w.result));
  console.log(`iteration ${iteration}: ways: ${show(cases, ways.map((w) => w.result))} (${solved}/${cases.length} solved)`);

  // 2. The model learns anew from the ways alone.
  const rows = [];
  for (const way of ways) {
    const pairs = way.result.reached ? way.result.pairs : way.result.pairs.slice(0, -TAIL);
    for (const p of pairs) if (p[4]) rows.push([p[4], p[1], way.result.reached ? 1 : 0.5]);
  }
  await writeFile(demosPath, JSON.stringify({ features: FEATURES, rows }));
  execFileSync("uv", ["run", "--project", join(repo, "tools", "distill"), "python", join(here, "fit_tux.py"),
                      demosPath, modelPath], { stdio: "inherit" });
  model = { ...JSON.parse(await readFile(modelPath, "utf8")), react: REACT };

  // 3. How it plays: the runs it learned from, and the runs it never saw.
  const trained = await playAll(cases, model);
  const held = heldout.length ? await playAll(heldout, model) : [];
  console.log(`iteration ${iteration}: model: ${goals(trained)}/${cases.length} of its runs to the goal; ` +
              `held out: ${show(heldout, held)} (${goals(held)}/${heldout.length} to the goal)`);
  const score = held.reduce((s, r) => s + far(r), 0) * 1e6 + trained.reduce((s, r) => s + far(r), 0);
  if (!best || score > best.score) {
    best = { score, iteration };
    await writeFile(join(tablesDir, `${args.name}.json`), JSON.stringify(model));
  }
}
console.log(`best: iteration ${best.iteration}, written to tables/${args.name}.json`);
await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
process.exit(0);
