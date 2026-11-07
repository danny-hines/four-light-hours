#!/bin/sh
# Dev only: offline FXC cost of every Uranus fragment shader. usage: sh src/bodies/uranus/tools/cost.sh [outDir]
D=${1:-shots/uranus/w2_dbg/hlsl}
rm -rf "$D"; mkdir -p "$D"
node src/bodies/uranus/tools/hlsl.mjs "$D" > /dev/null && python -I src/bodies/uranus/tools/fxc.py "$D"/*.hlsl
