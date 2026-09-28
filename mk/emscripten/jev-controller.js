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

// Lets a decision model give orders to the badguys near the player.
// The game side is src/port/jev_bridge.cpp: it calls window.jev_on_state()
// every jev_set_send_interval() seconds and takes orders through
// jev_set_order().
//
// A provider (selected with ?ai=<name>) turns the game state into questions
// and asks a model for
//
//   decide({ state, questions }) -> Promise<{ answers }>
//
// in the shape of TypeSafe's /v1/systemone API, which Laya shares. To run a
// model inside the browser (e.g. Laya on WebGPU, should a prompt ever take
// more inputs than a table can hold), add a provider here; nothing else needs
// to change.
//
// Other URL parameters: ?shield=0 (show Laya's own choices), ?interval=<s>
// (how often the game sends its state), ?speed=<x> and ?pursuit=0 / ?reflex=0
// (rich prompt only), ?options=<JEV_OPT_* bits> (for testing).

(function () {
  "use strict";

  // Keep in sync with JevOrder in src/badguy/jev_order.hpp
  const ORDERS = {
    patrol: 0, charge: 1, retreat: 2, hold: 3, jump: 4,
    ambush: 5, intercept: 6, stalk: 7, flank: 8, special: 9,
  };

  // Keep in sync with JEV_OPT_* in src/badguy/jev_order.hpp
  const OPT_RICH = 1, OPT_JUMPY = 2, OPT_PURSUIT = 4, OPT_REFLEX = 8;

  const ORDER_TTL = 1.0;        // seconds an order stays in effect
  const BACKOFF_MS = 1000;      // pause after an error

  // --- Jev: reads the facts and weighs the conditions itself ---------------

  // The model reads these literally, so they spell out when each action pays
  // off in terms of the facts the game reports, without negations (which the
  // model handles poorly). Checked against canonical situations: charging
  // from any distance is picked with 0.8-0.98 confidence, retreating from a
  // falling player with ~0.5-0.6. Jumping is rarely picked, but a charging
  // badguy that runs into a wall jumps anyway (see WalkingBadguy).
  const JEV_CRITERIA = {
    charge: "Run fast toward the player to hit them from the side. Best when the player is on the same level as me or below me, at any distance.",
    retreat: "Run away from the player. Best when the player is above me and falling toward me, or when the player is invincible.",
    hold: "Stand still facing the player. Best when a wall is in my way and the player is far.",
    jump: "Jump toward the player. Best when the player is above me and standing or rising, or when a wall is in my way and the player is near.",
  };

  function jevQuestions(state) {
    const questions = {};
    for (const id of Object.keys(state.enemies)) {
      questions[id] = {
        type: "choice",
        instructions:
          "You control enemy " + id + " in a 2D platformer and your goal is to defeat the player. " +
          "You hurt the player by touching them from the side. You die if the player lands on top of you. " +
          "Look at state.enemies." + id + " and state.player, then pick the best action for " + id + " right now.",
        criteria: JEV_CRITERIA,
      };
    }
    return questions;
  }

  // --- Laya, basic prompt: one situation sentence per badguy ---------------
  // The prompt is in laya-prompt.js (window.LayaPrompt).

  // The prompt boils every situation down to one of a handful of sentences,
  // so Laya's answers are precomputed into laya-table.js
  // (tools/laya-server/export-table.mjs). Looking them up gives exactly what
  // the model would say, in any browser, without downloading it.
  function lookUp(request) {
    const table = window.LAYA_TABLE;
    if (!table || table.instructions !== LayaPrompt.INSTRUCTIONS ||
        JSON.stringify(table.criteria) !== JSON.stringify(LayaPrompt.CRITERIA))
      throw new Error("laya-table.js was made for another prompt; run tools/laya-server/export-table.mjs");
    const answers = {};
    for (const [id, question] of Object.entries(request.questions)) {
      const answer = table.answers[question.state];
      if (!answer)
        throw new Error("laya-table.js has no answer for \"" + question.state + "\"; run tools/laya-server/export-table.mjs");
      answers[id] = answer;
    }
    return { model: table.model + " (table)", answers };
  }

  // --- Laya, rich prompt: nine yes/no questions per badguy ------------------
  // The prompt is in laya-rich-prompt.js (window.LayaRichPrompt).

  const RICH_MODEL = "aac6fef/laya-typed-decisions-mlx";

  /** The table's entry for a question, if it was made for this wording. */
  function richTableEntry(question) {
    const entry = window.LAYA_RICH_TABLE && window.LAYA_RICH_TABLE.nouls[question.name];
    const current = entry && entry.instructions === question.instructions &&
                    JSON.stringify(entry.criteria) === JSON.stringify(question.criteria);
    return current ? entry : null;
  }

  function richThresholds() {
    return Object.fromEntries(LayaRichPrompt.QUESTIONS.map((q) => {
      const entry = richTableEntry(q);
      return [q.name, entry ? entry.threshold : 0.5];
    }));
  }

  /** Turns each badguy's facts into a tactic, given P(yes) for a question. */
  function decideRich(state, answer, model) {
    const thresholds = richThresholds();
    const answers = {};
    for (const [id, enemy] of Object.entries(state.enemies)) {
      const decision = LayaRichPrompt.decide(LayaRichPrompt.facts(state.player, enemy), answer, thresholds);
      answers[id] = { choice: decision.order, confidence: decision.p, because: decision.because };
    }
    return { model, answers };
  }

  // laya-rich-table.js holds Laya's answer to every question the game can
  // produce (tools/laya-server/export-rich-table.mjs).
  function lookUpRich(request) {
    for (const question of LayaRichPrompt.QUESTIONS) {
      if (!richTableEntry(question))
        throw new Error("laya-rich-table.js was made for another prompt; run tools/laya-server/export-rich-table.mjs");
    }
    return decideRich(request.state, (question, sentence) => {
      const p = window.LAYA_RICH_TABLE.nouls[question.name].answers[sentence];
      if (p === undefined)
        throw new Error("laya-rich-table.js has no answer for \"" + sentence + "\"; run tools/laya-server/export-rich-table.mjs");
      return p;
    }, window.LAYA_RICH_TABLE.model + " (table)");
  }

  // --- Policy tables: one order for every combination of the rich facts ----
  // Written to <name>-table.js by tools/distill/fit.py (from a model's labels)
  // or by tools/rl (learned in play); the facts come from laya-rich-prompt.js.

  // Some tables (tools/coevo) also look at facts beyond the rich prompt's.
  // They keep the rich prompt's table as it is and list, for the finer
  // situations where they learned to do otherwise, what to do instead.
  const EXTRA_FACTS = {
    landed: (player) => !!player.just_landed,
    speed: (player) => player.speed,
    size: (player) => player.size,
    close: (player, enemy) => !!enemy.close,
    ally_attacking: (player, enemy) => !!enemy.ally_attacking,
    zone: (player, enemy) => enemy.zone,
    hopping: (player) => !!player.hopping,
  };

  /** The index of the extra facts, given the table's "extra" domains. */
  function extraIndex(extra, player, enemy) {
    let index = 0;
    for (const [fact, values] of extra) {
      const code = values.indexOf(EXTRA_FACTS[fact](player, enemy));
      index = index * values.length + Math.max(code, 0);
    }
    return index;
  }
  window.JevPolicy = { EXTRA_FACTS, extraIndex };

  const policies = {};
  function policy(name) {
    if (!policies[name]) {
      const table = window.POLICY_TABLES && window.POLICY_TABLES[name];
      if (!table)
        throw new Error(name + "-table.js is missing; see tools/distill/fit.py");
      const bytes = Uint8Array.from(atob(table.packed), (c) => c.charCodeAt(0));
      policies[name] = { table, bytes };
    }
    return policies[name];
  }

  function lookUpPolicy(name) {
    return function (request) {
      const { table, bytes } = policy(name);
      const answers = {};
      for (const [id, enemy] of Object.entries(request.state.enemies)) {
        const facts = LayaRichPrompt.facts(request.state.player, enemy);
        let index = 0;
        for (const [fact, values] of table.domains) {
          const code = values.indexOf(facts[fact]);
          if (code < 0)
            throw new Error(name + "-table.js does not know " + fact + " = " + facts[fact]);
          index = index * values.length + code;
        }
        let code = (bytes[index >> 1] >> ((index & 1) * 4)) & 15;
        if (table.extra) {
          const size = table.extra.reduce((n, [, values]) => n * values.length, 1);
          const finer = table.delta[index * size + extraIndex(table.extra, request.state.player, enemy)];
          if (finer !== undefined)
            code = finer;
        }
        answers[id] = { choice: table.orders[code], confidence: 1 };
      }
      return { model: table.model + " (table)", answers };
    };
  }

  // The same questions asked live (laya-mlx), e.g. to try a changed prompt
  // before exporting the table. Few distinct questions exist, so the answers
  // are kept and only new ones are asked.
  const richCache = new Map();
  async function askRich(request) {
    const pending = new Map();
    for (const enemy of Object.values(request.state.enemies)) {
      const f = LayaRichPrompt.facts(request.state.player, enemy);
      for (const question of LayaRichPrompt.QUESTIONS) {
        const sentence = question.sentence(f);
        const key = question.name + "\n" + sentence;
        if (!richCache.has(key) && !pending.has(key))
          pending.set(key, LayaRichPrompt.noul(question, sentence));
      }
    }
    if (pending.size) {
      const keys = [...pending.keys()];
      const result = await post("/api/laya")({
        model: RICH_MODEL,
        state: "",
        questions: Object.fromEntries(keys.map((key, i) => ["q" + i, pending.get(key)])),
      });
      keys.forEach((key, i) => richCache.set(key, result.answers["q" + i].noul));
    }
    return decideRich(request.state, (question, sentence) => richCache.get(question.name + "\n" + sentence),
                      RICH_MODEL + " (live)");
  }

  // --- Safety layer -------------------------------------------------------

  // Like the safety layer of the laya-mlx Snake demo, this overrides answers
  // that get the badguy killed: Laya picked the dodge for only 10 of 24 option
  // orders when the player falls onto the badguy, and never for an invincible
  // player. ?shield=0 shows Laya's own choices.
  function shielded(state, id) {
    const enemy = state.enemies[id];
    return !!enemy && (enemy.player_height === "above me and falling toward me" || state.player.invincible);
  }

  // --- Providers -----------------------------------------------------------

  function post(url) {
    return async function (request) {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
      });
      if (!response.ok)
        throw new Error("HTTP " + response.status + " " + (await response.text()).slice(0, 120));
      return response.json();
    };
  }

  const params = new URLSearchParams(location.search);
  const richOptions = OPT_RICH | OPT_JUMPY |
    (params.get("pursuit") === "0" ? 0 : OPT_PURSUIT) | (params.get("reflex") === "0" ? 0 : OPT_REFLEX);

  const providers = {
    // TypeSafe's Jev, through tools/jev-proxy (which holds the API key).
    jev: {
      sendInterval: 0.25,
      options: 0,
      // Below this the badguy keeps doing what it did. Dodging comes with
      // lower confidence than charging, yet whenever it is the top choice the
      // player really is about to land on the badguy.
      minConfidence: { charge: 0.5, retreat: 0.35, hold: 0.5, jump: 0.5 },
      buildQuestions: jevQuestions,
      decide: post("/api/jev"),
    },

    // Laya's precomputed answers to the basic prompt; runs in any browser.
    // Same pace and shield as laya-mlx, so the badguys behave the same.
    laya: {
      sendInterval: 0.05,
      options: 0,
      // Laya's confidence is 1 - normalised entropy, which stays low even for
      // right answers over four options; the top choice is used as is.
      minConfidence: {},
      buildQuestions: (state) => LayaPrompt.questions(state),
      shield: true,
      decide: lookUp,
      decideSync: lookUp,
    },

    // The rich prompt: more facts, more tactics (ambush, intercept, stalk,
    // flank, special moves), Jumpy joins in, badguys keep chasing offscreen
    // and dodge stomps by reflex. Precomputed; runs in any browser.
    "laya-rich": {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: true,
      decide: lookUpRich,
      decideSync: lookUpRich,
    },

    // The rich facts and behaviour, with the tactic for every situation
    // labeled by Claude Opus 5.5 and generalised with LightGBM
    // (tools/distill). Precomputed; runs in any browser.
    llm: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: true,
      decide: lookUpPolicy("llm"),
      table: "llm",
      decideSync: lookUpPolicy("llm"),
    },

    // The same, with the tactics learned in play by reinforcement learning
    // (tools/rl), starting from the llm table. Precomputed.
    rl: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: true,
      decide: lookUpPolicy("rl"),
      table: "rl",
      decideSync: lookUpPolicy("rl"),
    },

    // The second training (tools/rl/train.mjs): shared estimates, orders
    // changed only beyond doubt, rewards for teamwork too.
    rl2: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: true,
      decide: lookUpPolicy("rl2"),
      table: "rl2",
      decideSync: lookUpPolicy("rl2"),
    },

    // The badguys of the fifth generation of co-evolution (tools/coevo),
    // which learned against a Tux that learned too. Precomputed.
    coevo: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: true,
      decide: lookUpPolicy("coevo"),
      table: "coevo",
      decideSync: lookUpPolicy("coevo"),
    },

    // The champion of co-evolution with finer facts (tools/coevo --extend):
    // it also knows where in the level it is and when the player has just
    // landed, and learned for itself when to retreat, so no shield.
    coevo2: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: false,
      decide: lookUpPolicy("coevo2"),
      table: "coevo2",
      decideSync: lookUpPolicy("coevo2"),
    },

    // The champion of the third co-evolution: also trained against eight bot
    // styles on their own and against exploiters looking for its holes.
    coevo3: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: false,
      decide: lookUpPolicy("coevo3"),
      table: "coevo3",
      decideSync: lookUpPolicy("coevo3"),
    },

    // The champion of the fourth co-evolution: also sees whether the player
    // keeps jumping, and trained against jumpers too.
    coevo4: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: false,
      decide: lookUpPolicy("coevo4"),
      table: "coevo4",
      decideSync: lookUpPolicy("coevo4"),
    },

    // The champion of the co-evolution with a Tux that learned to get
    // through the whole level (tools/coevo/league.mjs, enemy-h16): it
    // learned against that Tux, against him starting late and against
    // badguys that now and then do something else.
    coevo5: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: false,
      decide: lookUpPolicy("coevo5"),
      table: "coevo5",
      decideSync: lookUpPolicy("coevo5"),
    },

    // Of the badguys of that co-evolution, the ones that stop the learned
    // Tuxes soonest (enemy-h13: against tux-s1, tux-h15, tux-r1 and tux-x1
    // starting 0 to 3 waits late, as few get through as against coevo5,
    // and those that do not fall about 1,300 px sooner).
    coevo6: {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: false,
      decide: lookUpPolicy("coevo6"),
      table: "coevo6",
      decideSync: lookUpPolicy("coevo6"),
    },

    // Laya running on this Mac's GPU through laya-mlx (tools/laya-server),
    // e.g. to try a changed prompt before exporting the table; ?prompt=rich
    // for the rich one. It answers in ~20 ms, so it could take a fresh state
    // every logic step (?interval=0, ~45 decisions/s), but that keeps the GPU
    // busy that also draws the game. 20 per second still reacts five times as
    // often as Jev.
    "laya-mlx": params.get("prompt") === "rich" ? {
      sendInterval: 0.05,
      options: richOptions,
      minConfidence: {},
      buildQuestions: () => ({}),
      shield: true,
      decide: askRich,
    } : {
      sendInterval: 0.05,
      options: 0,
      minConfidence: {},
      buildQuestions: (state) => LayaPrompt.questions(state),
      shield: true,
      decide: post("/api/laya"),
    },

    // No network and no model: every badguy gets the order from ?mock=<order>
    // (default: a simple rule). For checking the plumbing and the orders.
    mock: {
      sendInterval: 0.25,
      options: 0,
      minConfidence: {},
      buildQuestions: () => ({}),
      async decide(request) {
        const fixed = params.get("mock");
        const answers = {};
        for (const [id, enemy] of Object.entries(request.state.enemies)) {
          let choice = fixed;
          if (!(choice in ORDERS)) {
            if (enemy.player_height === "above me and falling toward me" || request.state.player.invincible) choice = "retreat";
            else if (enemy.wall_in_my_way) choice = (enemy.distance === "far") ? "hold" : "jump";
            else choice = "charge";
          }
          answers[id] = { type: "choice", choice, confidence: 1, probabilities: { [choice]: 1 } };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { model: "mock", answers };
      },
    },
  };

  // Any badguy table of co-evolution, for tools/coevo to play against:
  // ?ai=table&table=<name> loads <name>-table.js next to this script and
  // plays it as coevo4 is played (?shield=1 for tables that did not learn
  // when to retreat).
  if (params.get("ai") === "table" && params.get("table")) {
    const name = params.get("table");
    providers.table = { ...providers.coevo4, decide: lookUpPolicy(name), decideSync: lookUpPolicy(name), table: name,
                        shield: params.get("shield") === "1" };
  }

  // Without ?ai= the badguys behave as usual (the start page picks the mode).
  const providerName = params.get("ai") || "off";
  const provider = providers[providerName];

  // A policy table is a few hundred KB, so only the chosen mode's is loaded,
  // next to this script and with the same version. It is there long before
  // the game has loaded its data.
  if (provider && provider.table) {
    const script = document.createElement("script");
    const version = document.currentScript ? new URL(document.currentScript.src).search : "";
    script.src = provider.table + "-table.js" + version;
    document.head.appendChild(script);
  }
  const useShield = !!(provider && provider.shield) && params.get("shield") !== "0";
  const sendInterval = params.has("interval") ? Number(params.get("interval")) : provider && provider.sendInterval;
  const options = params.has("options") ? Number(params.get("options")) : provider ? provider.options : 0;
  const speed = params.has("speed") ? Number(params.get("speed")) : 1;

  let latestState = null;
  let busy = false;
  let pausedUntil = 0;
  let setOrder = null;
  let configured = false;
  const recent = [];            // timestamps of recent answers, for the rate
  const tactics = [];           // recent orders, for the mix shown on the HUD
  let answered = 0;
  let overridden = 0;
  let lastShown = 0;            // the HUD is written at most ten times a second

  const hud = document.createElement("div");
  hud.id = "jev_hud";
  hud.style.cssText =
    "position:fixed;right:8px;top:8px;z-index:10;padding:6px 8px;max-width:380px;" +
    "font:11px/1.4 ui-monospace,Menlo,monospace;color:#d6f5d6;background:#000a;" +
    "border-radius:4px;pointer-events:none;white-space:pre-wrap";
  function showStatus(text) {
    hud.textContent = "AI: " + providerName + (provider ? "" : " (off)") +
      (useShield ? "  shield on" : "") + "\n" + text;
  }

  function tacticMix() {
    const counts = {};
    for (const order of tactics)
      counts[order] = (counts[order] || 0) + 1;
    return Object.entries(counts).sort((a, b) => b[1] - a[1])
      .map(([order, n]) => order + " " + Math.round(100 * n / tactics.length) + "%").join("  ");
  }

  /** Hands the model's answers to the game and keeps the HUD up to date. */
  function applyAnswers(state, result, started) {
    const now = performance.now();

    if (!setOrder)
      setOrder = Module.cwrap("jev_set_order", null, ["number", "number", "number"]);

    // Under turbo (tools/eval) this runs hundreds of times a second, where
    // writing the HUD would cost more than the game itself.
    const show = now - lastShown >= 100;
    const lines = [];
    for (const [id, answer] of Object.entries(result.answers || {})) {
      let choice = answer.choice;
      let note = answer.because && answer.because !== choice ? "  (" + answer.because + ")" : "";
      answered++;
      if (useShield && shielded(state, id) && choice !== "retreat") {
        note = "  (shield: " + choice + ")";
        choice = "retreat";
        overridden++;
      }
      const confidence = answer.confidence ?? 1;
      const confident = confidence >= (provider.minConfidence[choice] ?? 0);
      if (ORDERS[choice] !== undefined && confident) {
        setOrder(Number(id.slice(1)), ORDERS[choice], ORDER_TTL);
        tactics.push(choice);
        if (tactics.length > 300)
          tactics.shift();
      }
      if (!show)
        continue;
      const kind = state.enemies[id] ? state.enemies[id].kind.slice(0, 6) : "";
      lines.push(id.padEnd(10) + " " + kind.padEnd(6) + " " + String(choice).padEnd(9) + " " + confidence.toFixed(2) +
                 (confident ? "" : "  (ignored)") + note);
    }

    recent.push(now);
    while (recent.length && recent[0] < now - 1000)
      recent.shift();

    if (!show)
      return;
    lastShown = now;
    showStatus(Math.round(now - started) + " ms  " + recent.length + " decisions/s  " + (result.model || "") +
               (useShield ? "\nshield overrides: " + overridden + "/" + answered : "") +
               "\n" + tacticMix() +
               "\n" + lines.join("\n"));
  }

  async function pump() {
    if (busy || !latestState || !provider || performance.now() < pausedUntil)
      return;

    const state = latestState;
    latestState = null;
    busy = true;
    const started = performance.now();
    try {
      applyAnswers(state, await provider.decide({ state, questions: provider.buildQuestions(state) }), started);
    } catch (error) {
      // The badguys simply fall back to their regular behaviour.
      pausedUntil = performance.now() + BACKOFF_MS;
      showStatus("error: " + error.message);
    } finally {
      busy = false;
    }

    // Only the newest state is worth asking about; older ones were dropped.
    pump();
  }

  // ?noise=<p>, for tools/coevo only: now and then a badguy does something
  // else for a while (10 decisions, half a second), so that a learned Tux
  // cannot count on every badguy doing exactly what it did before. The
  // numbers come from a seed set at every start of the level
  // (window.jev_noise_seed, called by tools/coevo/search.js), so the same
  // seed plays out the same way.
  const noise = Number(params.get("noise") || 0);
  const NOISE_ORDERS = ["charge", "retreat", "hold", "jump", "ambush", "intercept", "stalk", "flank", "special"];
  const NOISE_STICK = 10;
  let noiseState = 1;
  const noisy = new Map();  // id -> [order, decisions left]
  function noiseRandom() {
    noiseState = (noiseState + 0x6d2b79f5) >>> 0;
    let t = noiseState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  window.jev_noise_seed = function (seed) {
    noiseState = seed >>> 0;
    noisy.clear();
  };
  function addNoise(result) {
    if (!noise || !result || !result.answers)
      return result;
    for (const [id, answer] of Object.entries(result.answers)) {
      let n = noisy.get(id);
      if (!n && noiseRandom() < noise)
        noisy.set(id, n = [NOISE_ORDERS[Math.floor(noiseRandom() * NOISE_ORDERS.length)], NOISE_STICK]);
      if (n) {
        result.answers[id] = { ...answer, choice: n[0], confidence: 1 };
        if (--n[1] <= 0) noisy.delete(id);
      }
    }
    return result;
  }

  window.jev_on_state = function (json) {
    // The runtime is surely up once the game sends a state.
    if (!configured && provider) {
      if (Number.isFinite(sendInterval))
        Module.ccall("jev_set_send_interval", null, ["number"], [sendInterval]);
      Module.ccall("jev_set_options", null, ["number", "number"], [options, speed]);
      configured = true;
      // This state was made before the options: it lacks the rich facts.
      if (options & OPT_RICH)
        return;
    }

    let state;
    try {
      state = JSON.parse(json);
    } catch (error) {
      showStatus("bad state: " + error.message);
      return;
    }

    // Turbo (tools/eval) plays hundreds of logic steps between browser
    // frames. A promise would only settle once the whole batch is over, so
    // every state but the last would be dropped; a table can answer here and
    // now, while the game is waiting.
    if (provider && window.jev_inline && provider.decideSync) {
      const started = performance.now();
      // tools/rl puts its learner in place of the table while training.
      const decide = window.jev_decide_override || provider.decideSync;
      try {
        applyAnswers(state, addNoise(decide({ state, questions: provider.buildQuestions(state) })), started);
      } catch (error) {
        showStatus("error: " + error.message);
      }
      return;
    }

    latestState = state;
    pump();
  };

  window.addEventListener("DOMContentLoaded", function () {
    // Nothing to report when the badguys behave as usual.
    if (!provider)
      return;
    document.body.appendChild(hud);
    showStatus("waiting for the game...");
  });
})();
