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

// Teaches a learned model of Tux (LightGBM on the numbers of what he sees,
// fit_tux.py) to get through the level against several kinds of badguys,
// as DAgger does, with search as the teacher.
//
//   node tools/coevo/tux-model.mjs --teacher <table> --name <model> [--ai off,coevo5,table:<badguy>]
//        [--noisy coevo5] [--noise 0.03] [--noise-seeds 1,2,3] [--delays 0,2] [--iterations 20]
//        [--turbo 80] [--beam 12] [--depth 8] [--react 1] [--demos demos-<earlier>.json] [--max-search 8]
//        [--heldout-ai coevo5] [--heldout-delays 4,5] [--heldout-noise-seeds 21,22]
//
// First the teacher, one of Tux's tables, plays every run and what it did
// before failing (or all of it, where it got to the goal) is what the model
// learns from. Then, every iteration: the model is fit (fit_tux.py), plays
// every run, and where it fails a beam search finds a way on from a few of
// its moves before, a few hundred pixels past; those moves, with what Tux
// saw, are learned from next, counting three times. Unlike a table, the
// model decides on the numbers themselves (distances, speeds, where the
// badguys are), so what it learns in one run carries over to runs it has
// not seen. The best model so far goes to tables/<name>.json.
//
// Needs the web build, tools/jev-proxy/server.mjs on 8765 and the uv
// environment of tools/distill.

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const build = join(repo, "build.wasm");
const tablesDir = join(here, "tables");
const args = Object.fromEntries(process.argv.slice(2).reduce((pairs, arg, i, all) =>
  arg.startsWith("--") ? [...pairs, [arg.slice(2), all[i + 1]]] : pairs, []));
const ais = (args.ai || "off,coevo5").split(",");
const noisyAis = (args.noisy || "").split(",").filter(Boolean);
const noise = Number(args.noise || 0.03);
const noiseSeeds = (args["noise-seeds"] || "1,2,3").split(",").map(Number);
const delays = (args.delays || "0,2").split(",").map(Number);
const ITERATIONS = Number(args.iterations || 20);
const TURBO = Number(args.turbo || 80);
const BEAM = Number(args.beam || 12);
const DEPTH = Number(args.depth || 8);
const REACT = !!args.react;
const GOAL = 13380;
const AHEAD = 500;          // px past a failure a way on has to get
const BACK_OFF = [3, 6, 10]; // the model's moves given back before a failure
const TEACHER_TAIL = 8;     // the teacher's last moves before failing, not learned from
const MOVES = 9;
const CELL = 24;

const parse = (text) => JSON.parse(text.slice(text.indexOf("] = ") + 4, text.lastIndexOf(";")));
const pageKinds = [...ais, ...noisyAis.map((ai) => ai + "~")];
const cases = [
  ...ais.flatMap((ai) => delays.map((delay) => ({ ai, delay, seed: 1 }))),
  ...noisyAis.flatMap((ai) => noiseSeeds.map((seed) => ({ ai: ai + "~", delay: 0, seed }))),
];
// Runs never learned from, to tell a model that has learned to play from
// one that has learned these runs by heart: the best is the one that does
// best on these. --heldout-ai kinds (of --ai) with --heldout-delays, and
// the noisy kinds with --heldout-noise-seeds.
const heldoutAis = (args["heldout-ai"] || "").split(",").filter(Boolean);
const heldout = [
  ...heldoutAis.flatMap((ai) => (args["heldout-delays"] || "").split(",").filter(Boolean)
    .map((delay) => ({ ai, delay: Number(delay), seed: 1 }))),
  ...noisyAis.flatMap((ai) => (args["heldout-noise-seeds"] || "").split(",").filter(Boolean)
    .map((seed) => ({ ai: ai + "~", delay: 0, seed: Number(seed) }))),
];
const MAX_SEARCH = Number(args["max-search"] || 8);  // failures searched past each iteration
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

/** Plays every run with a policy (a table or a model); [{ case, result }]. */
async function playAll(policy, cases_ = cases) {
  const cases = cases_;
  const out = new Array(cases.length);
  await Promise.all(pageKinds.map(async (kind) => {
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      if (c.ai !== kind) continue;
      const r = await pages[kind].evaluate(([t, turbo, waits, seed, goal]) =>
        window.__search_policy(112, 576, goal, waits, t, turbo, seed, 300), [policy, TURBO, Array(c.delay).fill(2), c.seed, GOAL]);
      out[i] = { c, result: { ...r, pairs: r.pairs.slice(c.delay) } };
    }
  }));
  return out;
}

/** Beam search, on the page of this run, for moves after `prefix` that get
    past `goal` alive; their pairs (with what Tux saw), or null. */
async function searchFrom(c, prefix, goal) {
  const page = pages[c.ai];
  const waits = Array(c.delay).fill(2);
  let beam = [[]];
  for (let depth = 1; depth <= DEPTH && beam.length; depth++) {
    const sequences = beam.flatMap((s) => Array.from({ length: MOVES }, (_, m) => [...s, m]));
    const ends = new Map();
    for (const s of sequences) {
      const r = await page.evaluate(([moves, seed, turbo, react]) =>
        window.__search_try(112, 576, 1e9, moves, 0, turbo, seed, null, 300, null, react),
      [[...waits, ...prefix, ...s], c.seed, TURBO, REACT]);
      if (r.alive && r.x >= goal) return r.pairs.slice(waits.length + prefix.length);
      if (!r.alive) continue;
      const key = `${Math.round(r.x / CELL)} ${Math.round(r.y / CELL)} ${r.ground}`;
      const score = r.x + 0.8 * (576 - r.y);
      if (!ends.has(key) || ends.get(key).score < score) ends.set(key, { score, seq: s });
    }
    beam = [...ends.values()].sort((a, b) => b.score - a.score).slice(0, BEAM).map((e) => e.seq);
  }
  return null;
}

const far = (r) => (r.reached ? GOAL + 1000 : r.maxX);
const summary = (runs) => runs.map(({ c, result: r }) => `${label(c)} ${r.reached ? "GOAL" : r.maxX}`).join(", ");

// --- learning -------------------------------------------------------------------

const rows = [];
const addPairs = (pairs, weight) => {
  for (const p of pairs) if (p[4]) rows.push([p[4], p[1], weight]);
};

// --demos: what earlier runs of this learned from, to start with.
for (const path of (args.demos || "").split(",").filter(Boolean))
  rows.push(...JSON.parse(await readFile(join(here, path), "utf8")).rows);
const teacher = parse(await readFile(join(tablesDir, `${args.teacher}.js`), "utf8"));
const teacherRuns = await playAll({ packed: teacher.packed, extra: teacher.extra, delta: teacher.delta || {},
                                    react: !!teacher.react });
console.log(`teacher ${args.teacher}: ${summary(teacherRuns)}`);
for (const { result: r } of teacherRuns)
  addPairs(r.reached ? r.pairs : r.pairs.slice(0, Math.max(0, r.pairs.length - TEACHER_TAIL)), 1);

const FEATURES = (await import("node:vm")).runInNewContext(
  (await readFile(join(here, "player-facts.js"), "utf8")) + "; PlayerFacts.FEATURES", {});
const demosPath = join(here, `demos-${args.name}.json`);
const modelPath = join(here, `fit-${args.name}.json`);
let best = null;
for (let iteration = 1; iteration <= ITERATIONS; iteration++) {
  await writeFile(demosPath, JSON.stringify({ features: FEATURES, rows }));
  execFileSync("uv", ["run", "--project", join(repo, "tools", "distill"), "python", join(here, "fit_tux.py"),
                      demosPath, modelPath], { stdio: "inherit" });
  const model = { ...JSON.parse(await readFile(modelPath, "utf8")), react: REACT };
  const runs = await playAll(model);
  const score = runs.reduce((sum, { result: r }) => sum + far(r), 0);
  console.log(`iteration ${iteration}: ${summary(runs)}`);
  const held = heldout.length ? await playAll(model, heldout) : [];
  const heldScore = held.reduce((sum, { result: r }) => sum + far(r), 0);
  if (held.length)
    console.log(`iteration ${iteration}: held out: ${summary(held)} (${held.filter((h) => h.result.reached).length}/${held.length} to the goal)`);
  const judged = held.length ? heldScore * 1e6 + score : score;
  if (!best || judged > best.score) {
    best = { score: judged, iteration };
    await writeFile(join(tablesDir, `${args.name}.json`), JSON.stringify(model));
  }
  const failing = runs.filter(({ result: r }) => !r.reached);
  if (!failing.length) {
    console.log(`iteration ${iteration}: every run gets to the goal`);
    if (!held.length) break;
    continue;
  }
  // Ways on from where the model failed, found by search, to learn from:
  // the runs that got least far, one search at a time on each kind's page.
  const chosen = failing.sort((a, b) => a.result.maxX - b.result.maxX).slice(0, MAX_SEARCH);
  const byKind = new Map();
  for (const run of chosen) byKind.set(run.c.ai, [...(byKind.get(run.c.ai) || []), run]);
  let added = 0;
  await Promise.all([...byKind.values()].map(async (list) => {
    for (const { c, result: r } of list) {
      const moves = r.pairs.map((p) => p[1]);
      const reachedAt = r.pairs.findIndex((p) => p[2] >= r.maxX - 48);
      const upTo = reachedAt < 0 ? moves.length : reachedAt + 1;
      for (const back of BACK_OFF) {
        if (upTo - back < 0) continue;
        const found = await searchFrom(c, moves.slice(0, upTo - back), Math.min(GOAL, r.maxX + AHEAD));
        if (found) {
          addPairs(found, 3);
          added += found.length;
          break;
        }
      }
    }
  }));
  console.log(`iteration ${iteration}: ${added} moves found past failures, ${rows.length} rows`);
  if (!added) break;
}
console.log(`best: iteration ${best.iteration}, written to tables/${args.name}.json`);
await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
process.exit(0);
