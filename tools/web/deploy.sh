#!/bin/sh
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

# Deploys the web build to Cloudflare (tools/web/cloudflare): the pages and
# code as Workers static assets, the data package to the R2 bucket
# laya-supertux in parts (see worker.js for why).
#
#   tools/web/deploy.sh [build dir]
#
# Needs `wrangler login` and, once, `wrangler r2 bucket create laya-supertux`,
# `wrangler d1 create supertux-stats` (its id goes into wrangler.jsonc) and
# `wrangler d1 execute supertux-stats --remote --file tools/web/cloudflare/schema.sql`
# and `openssl rand -hex 32 | wrangler secret put STATS_SECRET`.
# The data parts are uploaded under their content hash before the Worker is
# deployed, so the site switches to the new build in one step. Parts of older
# builds stay in the bucket until deleted.

set -e

repo=$(cd "$(dirname "$0")/../.." && pwd)
build=${1:-$repo/build.wasm}
dist=$build/dist
bucket=laya-supertux

# Everything the pages load, except the data package.
rm -rf "$dist"
mkdir -p "$dist"
for file in index.html play.html credits.html \
            LICENSE.txt AUTHORS.txt supertux-credits.txt third-party-licenses.txt \
            supertux2.js supertux2.wasm supertux2.png supertux2_bkg.png supertux2.ico \
            jev-controller.js stats.js headstone.png og.png laya-prompt.js laya-table.js laya-rich-prompt.js laya-rich-table.js llm-table.js rl-table.js rl2-table.js coevo-table.js coevo2-table.js coevo3-table.js coevo4-table.js coevo5-table.js coevo6-table.js; do
  cp "$build/$file" "$dist/"
done

# The data package, in parts below Wrangler's 300 MiB upload limit.
version=$(shasum -a 256 "$build/supertux2.data" | cut -c1-16)
parts=$build/data-parts
rm -rf "$parts"
mkdir -p "$parts"
split -b 200m "$build/supertux2.data" "$parts/part-"
count=0
for part in "$parts"/part-*; do
  wrangler r2 object put "$bucket/data/$version/$count" --file "$part" \
    --content-type application/octet-stream --remote
  count=$((count + 1))
done

cd "$repo/tools/web/cloudflare"
wrangler deploy --var "DATA_VERSION:$version" --var "DATA_PARTS:$count"
echo "Deployed data package $version in $count parts"
