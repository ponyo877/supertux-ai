#  SuperTux
#  Copyright (C) 2026 ponyo877
#
#  This program is free software: you can redistribute it and/or modify
#  it under the terms of the GNU General Public License as published by
#  the Free Software Foundation, either version 3 of the License, or
#  (at your option) any later version.
#
#  This program is distributed in the hope that it will be useful,
#  but WITHOUT ANY WARRANTY; without even the implied warranty of
#  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
#  GNU General Public License for more details.
#
#  You should have received a copy of the GNU General Public License
#  along with this program.  If not, see <http://www.gnu.org/licenses/>.

"""One step of reinforcement learning for Tux's model (tux-rl.mjs).

    uv run --project tools/distill python tools/coevo/fit_awr.py samples.json model.json [--demos demos.json] [--demo-weight 1]

samples.json: {"features": [...], "rows": [[[f1, ...], move, return], ...]},
every move Tux made in the runs played, with what he saw and what came of
it (the discounted sum of the rewards after it). Advantage-weighted
regression: a LightGBM regression learns what usually comes of being
where he was (the value; out of fold, so it does not learn the rows by
heart), and the model learns the moves again, each counting by how much
better than usual it did: exp(advantage / beta), beta the spread of the
advantages, at most 20. So what worked is done more and what did not
less, and the model stays one fit_tux.py's form.
"""

import json
import sys

import lightgbm as lgb
import numpy as np

sys.path.insert(0, __import__("os").path.dirname(__file__))
from fit_tux import export  # noqa: E402

FOLDS = 3
MAX_WEIGHT = 20.0


def main():
    samples_path, out_path = sys.argv[1], sys.argv[2]
    with open(samples_path) as f:
        samples = json.load(f)
    rows = samples["rows"]
    x = np.array([r[0] for r in rows], dtype=float)
    actions = np.array([r[1] for r in rows])
    returns = np.array([r[2] for r in rows], dtype=float)

    # The value, out of fold.
    value = np.zeros(len(rows))
    folds = np.random.default_rng(1).integers(0, FOLDS, len(rows))
    params = dict(objective="regression", learning_rate=0.05, num_leaves=31, min_child_samples=20,
                  verbose=-1, seed=1)
    for k in range(FOLDS):
        train, test = folds != k, folds == k
        booster = lgb.train(params, lgb.Dataset(x[train], returns[train]), num_boost_round=200)
        value[test] = booster.predict(x[test])
    advantage = returns - value
    beta = max(float(advantage.std()), 1e-6)
    weights = np.minimum(np.exp(advantage / beta), MAX_WEIGHT)
    weights = weights / weights.mean()

    # --demos: moves shown to be good (ways played to the goal, as
    # tux-expert.mjs keeps them), learned from alongside at their own
    # weight, so that learning by trying does not stray far from them.
    if "--demos" in sys.argv:
        with open(sys.argv[sys.argv.index("--demos") + 1]) as f:
            shown = json.load(f)["rows"]
        scale = float(sys.argv[sys.argv.index("--demo-weight") + 1]) if "--demo-weight" in sys.argv else 1.0
        x = np.vstack([x, np.array([r[0] for r in shown], dtype=float)])
        actions = np.concatenate([actions, np.array([r[1] for r in shown])])
        weights = np.concatenate([weights, np.full(len(shown), scale)])

    moves_seen = sorted(set(actions.tolist()))
    code = {m: i for i, m in enumerate(moves_seen)}
    y = np.array([code[a] for a in actions])
    booster = lgb.train(dict(objective="multiclass", num_class=len(moves_seen), learning_rate=0.05, num_leaves=31,
                             min_child_samples=10, verbose=-1, seed=1),
                        lgb.Dataset(x, y, weight=weights), num_boost_round=200)
    with open(out_path, "w") as f:
        json.dump(export(booster, moves_seen), f)
    print(f"{len(rows)} moves, return {returns.mean():.3f}, value explains "
          f"{1 - np.var(advantage) / max(np.var(returns), 1e-9):.2f} of it, beta {beta:.3f}, "
          f"weights up to {weights.max():.1f}")


if __name__ == "__main__":
    main()
