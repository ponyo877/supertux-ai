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

"""Learns a model of Tux from demonstrations (tux-model.mjs).

    uv run --project tools/distill python tools/coevo/fit_tux.py demos.json model.json [--drop x,y]

demos.json: {"features": [...names], "rows": [[[f1, f2, ...], move, weight], ...]},
the numbers Tux looked at (player-facts.js FEATURES) and the move made there.
A LightGBM classifier learns the move from the numbers, as in distilling a
language model's moves into LightGBM; each row counts by its weight times
the inverse square root of how common its move and its part of the level
are (so rare moves at rare places are not drowned), kept within 0.1 to 10
and averaging 1. The trees go to model.json in the form player-facts.js's
modelMove reads: per tree, nodes [feature, threshold, left, right] with
leaves as negative children.
"""

import json
import sys
from collections import Counter

import lightgbm as lgb
import numpy as np

ZONE = 400.0  # px: the parts of the level for the weights


def export(booster, moves):
    dump = booster.dump_model()
    trees = []
    for info in dump["tree_info"]:
        nodes, leaves = [], []

        def walk(node):
            if "leaf_index" in node or "leaf_value" in node and "split_feature" not in node:
                leaves.append(node["leaf_value"])
                return -len(leaves)
            index = len(nodes)
            nodes.append(None)
            left = walk(node["left_child"])
            right = walk(node["right_child"])
            assert node["decision_type"] == "<="
            nodes[index] = [node["split_feature"], node["threshold"], left, right]
            return index

        root = walk(info["tree_structure"])
        trees.append({"root": root, "nodes": nodes, "leaves": leaves})
    return {"classes": len(moves), "moves": moves, "trees": trees}


def main():
    demos_path, out_path = sys.argv[1], sys.argv[2]
    with open(demos_path) as f:
        demos = json.load(f)
    rows = demos["rows"]
    x = np.array([r[0] for r in rows], dtype=float)
    # --drop x,y: features the model may not use (set to 0 everywhere), e.g.
    # where in the level Tux is, so it cannot learn a way by heart.
    dropped = []
    if "--drop" in sys.argv:
        dropped = [demos["features"].index(n) for n in sys.argv[sys.argv.index("--drop") + 1].split(",")]
    zone_x = x[:, demos["features"].index("x")].copy()
    moves_seen = sorted({r[1] for r in rows})
    code = {m: i for i, m in enumerate(moves_seen)}
    y = np.array([code[r[1]] for r in rows])
    base = np.array([r[2] if len(r) > 2 else 1.0 for r in rows], dtype=float)

    zones = (zone_x // ZONE).astype(int)
    for col in dropped:
        x[:, col] = 0.0
    by_move = Counter(y.tolist())
    by_zone = Counter(zones.tolist())
    w = base / np.sqrt(np.array([by_move[m] * by_zone[z] for m, z in zip(y, zones)], dtype=float))
    w = w / w.mean()
    w = np.clip(w, 0.1, 10.0)
    w = w / w.mean()

    params = dict(objective="multiclass" if len(moves_seen) > 2 else "binary",
                  learning_rate=0.05, num_leaves=31, min_child_samples=5, verbose=-1, seed=1)
    if len(moves_seen) > 2:
        params["num_class"] = len(moves_seen)
    booster = lgb.train(params, lgb.Dataset(x, y, weight=w), num_boost_round=200)
    predicted = booster.predict(x)
    if predicted.ndim == 1:
        predicted = np.stack([1 - predicted, predicted], axis=1)
    agree = float((predicted.argmax(axis=1) == y).mean())

    model = export(booster, moves_seen)
    if len(moves_seen) == 2:
        # A binary model's trees score the second move; the first scores zero.
        model = {"classes": 2, "moves": moves_seen,
                 "trees": [t for tree in model["trees"] for t in ({"root": -1, "nodes": [], "leaves": [0.0]}, tree)]}
    with open(out_path, "w") as f:
        json.dump(model, f)
    print(f"{len(rows)} rows, moves {moves_seen}, agrees with the demonstrations on {agree:.3f}, "
          f"{len(model['trees'])} trees")


if __name__ == "__main__":
    main()
