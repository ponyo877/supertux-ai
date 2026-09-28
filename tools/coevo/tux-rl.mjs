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

// Reinforcement learning for a learned model of Tux: it plays runs drawn at
// random and learns from what came of its own moves (fit_awr.py), so that
// it gets through runs it has never seen, not only those it was shown.
//
//   node tools/coevo/tux-rl.mjs --from <model>.json --name <model> [--ai off,coevo5,table:<badguy>,...]
//        [--noisy coevo5] [--episodes 240] [--iterations 60] [--temperature 1] [--epsilon 0.03]
//        [--react 1] [--turbo 80] [--demos demos-<model>.json] [--demo-weight 1]
//
// Every iteration, the model plays --episodes runs, each against one of the
// kinds of badguys (--ai, and --noisy ones that now and then do something
// else, with a seed from 100 up), starting 0 to 3 waits late, drawing its
// moves by its odds (--temperature) and now and then any move (--epsilon).
// Every move is rewarded by the progress after it (1 per 1000 px), the goal
// (+3) or falling (-1; getting nowhere -0.5), discounted by 0.95 a move.
// fit_awr.py learns from the last two iterations' moves (and from --demos,
// ways shown to get to the goal, so that trying does not stray from them). The model plays,
// without drawing, runs it never learns from: starting 4 and 5 waits late,
// and noisy badguys with seeds 21 to 26; the best on those is kept, in
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
const ais = list(args.ai, "off,coevo5,table:enemy-h13,table:enemy-h10,table:enemy-h6");
const noisyAis = list(args.noisy, "coevo5");
const EPISODES = Number(args.episodes || 240);
const ITERATIONS = Number(args.iterations || 60);
const TEMPERATURE = Number(args.temperature || 1);
const EPSILON = Number(args.epsilon ?? 0.03);
const REACT = !!args.react;
const TURBO = Number(args.turbo || 80);
const GOAL = 13380;
const GAMMA = 0.95;
const KEEP = 2;  // iterations whose moves are learned from

const pageKinds = [...ais, ...noisyAis.map((ai) => ai + "~")];
const heldout = [
  ...["coevo5", "table:enemy-h10"].filter((ai) => ais.includes(ai))
    .flatMap((ai) => [4, 5].map((delay) => ({ ai, delay, seed: 1 }))),
  ...noisyAis.flatMap((ai) => [21, 22, 23, 24, 25, 26].map((seed) => ({ ai: ai + "~", delay: 0, seed }))),
];
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
  const extra = kind.endsWith("~") ? "&noise=0.03" : "";
  if (!ai.startsWith("table:")) return `ai=${ai}${extra}`;
  const name = ai.slice(6);
  await copyFile(join(tablesDir, `${name}.js`), join(build, `${name}-table.js`));
  return `ai=table&table=${encodeURIComponent(name)}${extra}`;
}

const browser = await chromium.launch({ headless: true, channel: "chromium", args: ["--mute-audio"] });
process.on("exit", () => { try { browser.process()?.kill("SIGKILL"); } catch {} });
const pages = {};
async function openPage(kind) {
  const page = await (await browser.newContext({ viewport: { width: 640, height: 360 } })).newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto(`http://127.0.0.1:8765/search.html?${await aiQuery(kind)}&v=${v}`, { timeout: 300000 });
  await page.waitForFunction(() => document.title.startsWith("SuperTux"), null, { timeout: 300000 });
  await page.waitForTimeout(1000);
  await page.evaluate(() => { window.__search_features = true; return window.__search_ready(); });
  return page;
}
for (const kind of pageKinds)
  pages[kind] = await openPage(kind);

// A run takes seconds; one that has not ended in RUN_TIMEOUT means the
// game in that page has hung (seen once after hours): the page is opened
// anew and the run played again.
const RUN_TIMEOUT = 180000;

async function run(c, policy) {
  const waits = Array(c.delay).fill(2);
  for (;;) {
    const page = pages[c.ai];
    const r = await Promise.race([
      page.evaluate(([waits, policy, seed, turbo, goal]) =>
        window.__search_policy(112, 576, goal, waits, policy, turbo, seed, 300), [waits, policy, c.seed, TURBO, GOAL]),
      new Promise((resolve) => setTimeout(() => resolve(null), RUN_TIMEOUT)),
    ]).catch(() => null);
    if (r)
      return { ...r, pairs: r.pairs.slice(waits.length) };
    console.log(`  ${c.ai}: a run hung; the page is opened anew`);
    page.context().close().catch(() => {});
    pages[c.ai] = await openPage(c.ai);
  }
}

/** Runs on the pages, each page one at a time; results in order. */
async function runAll(list, policy) {
  const out = new Array(list.length);
  await Promise.all(pageKinds.map(async (kind) => {
    for (let i = 0; i < list.length; i++)
      if (list[i].ai === kind) out[i] = await run(list[i], policy);
  }));
  return out;
}

/** Every move of a run with what came of it: [features, move, return]. */
function returns(r) {
  const pairs = r.pairs.filter((p) => p[4]);
  const end = r.reached ? 3 : r.alive ? -0.5 : -1;
  const rewards = pairs.map((p, i) => ((i + 1 < pairs.length ? pairs[i + 1][2] : r.x) - p[2]) / 1000 +
                                      (i + 1 === pairs.length ? end : 0));
  const out = new Array(pairs.length);
  let g = 0;
  for (let i = pairs.length - 1; i >= 0; i--) {
    g = rewards[i] + GAMMA * g;
    out[i] = [pairs[i][4], pairs[i][1], +g.toFixed(4)];
  }
  return out;
}

const far = (r) => (r.reached ? GOAL + 1000 : r.maxX);
const goals = (rs) => rs.filter((r) => r.reached).length;

// --- learning -------------------------------------------------------------------

const FEATURES = vm.runInNewContext((await readFile(join(here, "player-facts.js"), "utf8")) + "; PlayerFacts.FEATURES", {});
let model = { ...JSON.parse(await readFile(join(tablesDir, args.from), "utf8")), react: REACT };
const samplesPath = join(here, `samples-${args.name}.json`);
const modelPath = join(here, `fit-${args.name}.json`);
const history = [];
let best = null;
let seedCounter = 100;

for (let iteration = 0; iteration <= ITERATIONS; iteration++) {
  // How it plays, without drawing: runs it never learns from.
  const held = await runAll(heldout, model);
  const heldScore = held.reduce((s, r) => s + far(r), 0);
  console.log(`iteration ${iteration}: held out: ${heldout.map((c, i) => `${label(c)} ${held[i].reached ? "GOAL" : held[i].maxX}`).join(", ")} ` +
              `(${goals(held)}/${heldout.length} to the goal)`);
  if (!best || heldScore > best.score) {
    best = { score: heldScore, iteration };
    await writeFile(join(tablesDir, `${args.name}.json`), JSON.stringify(model));
  }
  if (iteration === ITERATIONS) break;

  // Runs drawn at random, played drawing moves.
  const episodes = Array.from({ length: EPISODES }, (_, i) => {
    const ai = pageKinds[i % pageKinds.length];
    return { ai, delay: Math.floor(Math.random() * 4), seed: ai.endsWith("~") ? seedCounter++ : 1 };
  });
  const played = await runAll(episodes, { ...model, temperature: TEMPERATURE, epsilon: EPSILON });
  const rows = played.flatMap(returns);
  history.push(rows);
  if (history.length > KEEP) history.shift();
  console.log(`iteration ${iteration + 1}: played ${EPISODES} runs: ${goals(played)} to the goal, ` +
              `${Math.round(played.reduce((s, r) => s + r.maxX, 0) / EPISODES)} px on average`);

  await writeFile(samplesPath, JSON.stringify({ features: FEATURES, rows: history.flat() }));
  execFileSync("uv", ["run", "--project", join(repo, "tools", "distill"), "python", join(here, "fit_awr.py"),
                      samplesPath, modelPath, ...(args.demos ? ["--demos", join(here, args.demos),
                      "--demo-weight", String(args["demo-weight"] || 1)] : [])], { stdio: "inherit" });
  model = { ...JSON.parse(await readFile(modelPath, "utf8")), react: REACT };
}
console.log(`best: iteration ${best.iteration}, written to tables/${args.name}.json`);
await Promise.race([browser.close().catch(() => {}), new Promise((r) => setTimeout(r, 10000))]);
process.exit(0);
