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

// What a learned Tux sees and what it can do (tools/coevo).
//
// The facts come from the benchmark's view of the level (jev_set_bench in
// src/port/jev_bridge.cpp), always looking right, where the level goes. The
// moves are short, whole manoeuvres rather than single keys; a policy table
// picks one per situation, like the badguys' tables pick an order.
//
// Loaded by the game page (as window.PlayerFacts) and by Node (module.exports).

(function (root) {
  "use strict";

  const TILE = 32;

  // The table is indexed by these, in this order.
  const DOMAINS = [
    ["air", ["ground", "rising", "falling"]],
    ["speed", ["still", "walk", "run"]],
    ["wall", ["none", "near low", "near high", "near cliff", "far low", "far high", "far cliff"]],
    ["gap", ["none", "near narrow", "near wide", "far narrow", "far wide"]],
    ["spikes", ["none", "near", "far"]],
    ["ledge", ["none", "ahead low", "ahead high", "behind low", "behind high", "above low", "above high"]],
    ["enemy", ["none", "touching", "near", "medium"]],
    ["enemy_coming", [false, true]],
    ["enemy_kind", ["walker", "bomb", "jumpy"]],
    ["enemy_above", [false, true]],
    ["enemy_behind", [false, true]],
  ];

  // input bits: left 1, right 2, up 4, down 8, jump 16, action 32
  const MOVES = [
    { name: "run", input: 2 | 32, seconds: 0.2 },
    { name: "walk", input: 2, seconds: 0.2 },
    { name: "wait", input: 0, seconds: 0.2 },
    { name: "back", input: 1, seconds: 0.25 },
    { name: "hop", input: 2, jump: 0.12 },
    { name: "jump", input: 2, jump: 0.35 },
    { name: "long jump", input: 2 | 32, jump: 0.6 },
    { name: "high jump", input: 0, jump: 0.6 },
    { name: "back jump", input: 1, jump: 0.6 },
  ];

  const KIND = { mrbomb: "bomb", jumpy: "jumpy" };

  function facts(b) {
    const near = (d, limit) => d >= 0 && d < limit;
    const wallSize = b.wall_h <= 2 * TILE ? "low" : b.wall_h <= 4 * TILE ? "high" : "cliff";
    const wall = b.wall_r < 0 || b.wall_r >= 160 ? "none" : (b.wall_r < 48 ? "near " : "far ") + wallSize;
    const gap = b.gap_r < 0 || b.gap_r >= 160 ? "none" : (b.gap_r < 48 ? "near " : "far ") + (b.gap_w <= 2 * TILE ? "narrow" : "wide");
    const spikes = near(b.spikes_r, 64) ? "near" : near(b.spikes_r, 160) ? "far" : "none";
    let ledge = "none";
    if (b.ledge) {
      const where = Math.abs(b.ledge_dx) < 24 ? "above" : b.ledge_dx > 0 ? "ahead" : "behind";
      ledge = where + (b.ledge_dy <= 3 * TILE ? " low" : " high");
    }

    // The nearest badguy in front, on about the same level.
    let ahead = null;
    let above = false;
    let behind = false;
    for (const [dx, dy, vx, , kind] of b.enemies) {
      if (Math.abs(dx) < 64 && dy < -40 && dy > -200) above = true;
      if (Math.abs(dy) >= 64) continue;
      if (dx >= -8 && dx < 260 && (!ahead || dx < ahead.dx)) ahead = { dx, vx, kind };
      if (dx < -8 && dx > -120) behind = true;
    }
    return {
      air: b.ground ? "ground" : b.vy < 0 ? "rising" : "falling",
      speed: Math.abs(b.vx) < 30 ? "still" : Math.abs(b.vx) < 250 ? "walk" : "run",
      wall, gap, spikes, ledge,
      enemy: !ahead ? "none" : ahead.dx < 40 ? "touching" : ahead.dx < 120 ? "near" : "medium",
      enemy_coming: !!ahead && ahead.vx < -10,
      enemy_kind: ahead ? KIND[ahead.kind] || "walker" : "walker",
      enemy_above: above,
      enemy_behind: behind,
    };
  }

  function index(f) {
    let i = 0;
    for (const [name, values] of DOMAINS) {
      const code = values.indexOf(f[name]);
      if (code < 0) throw new Error("player fact " + name + " = " + f[name]);
      i = i * values.length + code;
    }
    return i;
  }

  const LEVEL_WIDTH = 15200;

  // Finer facts a table may add after those of DOMAINS ("extra", as the
  // badguys' tables do): each gives the code of its value for a look.
  const ENEMY_DX = [24, 48, 80, 120, 180, 260];  // px ahead: bands 1..6, 0 = none so close
  const EXTRA_FACTS = {
    // Which part of the level Tux is in (so many zones of equal width).
    zone: (b, values) => Math.min(Math.floor(Math.max(b.x, 0) / (LEVEL_WIDTH / values.length)), values.length - 1),
    // How far ahead the nearest badguy on about his level is, finer than
    // "enemy" (touching, near, medium).
    enemy_dx: (b) => {
      let nearest = Infinity;
      for (const [dx, dy] of b.enemies)
        if (Math.abs(dy) < 64 && dx >= -8 && dx < nearest) nearest = dx;
      const band = ENEMY_DX.findIndex((limit) => nearest < limit);
      return band < 0 ? 0 : band + 1;
    },
    // Where the nearest badguy within 200 px is: behind, over or under him,
    // or ahead; near (under 80 px) or not; above, level or below. 0: none.
    // It tells a badguy about to drop on him from one passing by.
    threat: (b) => {
      let best = null;
      for (const [dx, dy] of b.enemies) {
        const d = Math.hypot(dx, dy);
        if (d < 200 && (!best || d < best.d)) best = { dx, dy, d };
      }
      if (!best) return 0;
      const side = best.dx < -24 ? 0 : best.dx <= 24 ? 1 : 2;
      const near = best.d < 80 ? 0 : 1;
      const vertical = best.dy < -32 ? 0 : best.dy > 32 ? 2 : 1;
      return 1 + side * 6 + near * 3 + vertical;
    },
  };

  /** The index in a table with finer facts: `extra` is the table's list of
      [name, values], or a number of zones (the tables that have only
      those), or 0 for none. */
  function extendedIndex(b, extra) {
    const base = index(facts(b));
    if (!extra)
      return base;
    if (typeof extra === "number")
      extra = [["zone", Array.from({ length: extra }, (_, i) => i)]];
    let i = base;
    for (const [name, values] of extra)
      i = i * values.length + EXTRA_FACTS[name](b, values);
    return i;
  }

  // A table made to react (its "react"): a move ends early when a badguy
  // comes this close, so Tux decides again at once rather than at the end
  // of the move (in the air, once the jump key is let go). Decisions are
  // coarse where nothing happens and fine where something does.
  const DANGER = 72;        // px from Tux's middle to a badguy's
  const MIN_MOVE = 0.06;    // s a move lasts at least

  /** Whether the move under way should end now for a table that reacts. */
  function reacts(b, move, time) {
    if (!move || time - move.start < MIN_MOVE - 0.015)
      return false;
    if (move.jumping && time < move.jumpUntil)
      return false;
    return b.enemies.some(([dx, dy]) => Math.hypot(dx, dy) < DANGER);
  }

  /** The index in a table with `zones` zones along the level (0: none). */
  const zonedIndex = (b, zones) => extendedIndex(b, zones);

  // What a learned model of Tux (tux-model.mjs, fit_tux.py) decides on: the
  // numbers of the look itself rather than the coarse facts above, so that
  // it can tell apart what the facts lump together. Far or missing things
  // are FAR; the three nearest badguys (within 400 px) come last.
  const FAR = 999;
  const KIND_CODE = { mrbomb: 1, jumpy: 2 };
  const FEATURES = ["vx", "vy", "ground", "big", "x", "y", "wall_r", "wall_h", "gap_r", "gap_w", "spikes_r",
                    "ledge", "ledge_dx", "ledge_dy",
                    ...[1, 2, 3].flatMap((n) => [`e${n}_dx`, `e${n}_dy`, `e${n}_vx`, `e${n}_vy`, `e${n}_kind`]),
                    // Added later (older models read only what comes before):
                    // how soon the nearest badguy reaches Tux across and
                    // up or down, at the speeds both have (FAR if not).
                    "e1_tx", "e1_ty"];

  function features(b) {
    const far = (v) => (v < 0 ? FAR : v);
    const out = [b.vx, b.vy, b.ground ? 1 : 0, b.big ? 1 : 0, b.x, b.y, far(b.wall_r), b.wall_h, far(b.gap_r), b.gap_w,
                 far(b.spikes_r), b.ledge ? 1 : 0, b.ledge ? b.ledge_dx : 0, b.ledge ? b.ledge_dy : 0];
    const near = b.enemies.map(([dx, dy, vx, vy, kind]) => ({ dx, dy, vx, vy, kind, d: Math.hypot(dx, dy) }))
      .filter((e) => e.d < 400).sort((a, c) => a.d - c.d);
    for (let n = 0; n < 3; n++) {
      const e = near[n];
      out.push(...(e ? [e.dx, e.dy, e.vx, e.vy || 0, KIND_CODE[e.kind] || 0] : [FAR, FAR, 0, 0, -1]));
    }
    // Seconds until the gap closes, when it closes at all.
    const soon = (gap, closing) => (closing > 1 && gap / closing < 10 ? gap / closing : FAR);
    const e = near[0];
    out.push(e ? soon(Math.abs(e.dx), -Math.sign(e.dx) * ((e.vx || 0) - b.vx)) : FAR,
             e ? soon(Math.abs(e.dy), -Math.sign(e.dy) * ((e.vy || 0) - b.vy)) : FAR);
    return out;
  }

  /** The move a learned model (as fit_tux.py exports it) makes for a look:
      the likeliest, or with model.temperature one drawn by the model's
      odds (softmax of its scores at that temperature), and with
      model.epsilon now and then any move (tux-rl.mjs, trying things). */
  function modelMove(model, b) {
    const f = features(b);
    const scores = new Array(model.classes).fill(0);
    for (let t = 0; t < model.trees.length; t++) {
      const tree = model.trees[t];
      // Nodes: [feature, threshold, left, right]; a child (or the root) below
      // zero is the leaf -child - 1.
      let node = tree.root;
      while (node >= 0) {
        const [feature, threshold, left, right] = tree.nodes[node];
        node = f[feature] <= threshold ? left : right;
      }
      scores[t % model.classes] += tree.leaves[-node - 1];
    }
    if (model.epsilon && Math.random() < model.epsilon)
      return model.moves[Math.floor(Math.random() * model.moves.length)];
    if (model.temperature) {
      const top = Math.max(...scores);
      const odds = scores.map((s) => Math.exp((s - top) / model.temperature));
      let r = Math.random() * odds.reduce((a, c) => a + c, 0);
      for (let c = 0; c < odds.length; c++) if ((r -= odds[c]) <= 0) return model.moves[c];
    }
    let best = 0;
    for (let c = 1; c < scores.length; c++) if (scores[c] > scores[best]) best = c;
    return model.moves[best];
  }

  const api = { DOMAINS, MOVES, LEVEL_WIDTH, EXTRA_FACTS, FEATURES, facts, index, extendedIndex, zonedIndex, reacts,
                features, modelMove };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.PlayerFacts = api;
})(this);
