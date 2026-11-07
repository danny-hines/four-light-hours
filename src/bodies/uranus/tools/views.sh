#!/bin/sh
# Render the critic's required Uranus views. usage: sh src/bodies/uranus/tools/views.sh <prefix> [extra query] (from project root)
P=${1:-v}
X=${2:-&only=uranus}
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=5&phase=10&el=5$X" --out shots/uranus/${P}_bullseye.png &
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=4&phase=70&el=10$X" --out shots/uranus/${P}_side.png &
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=4&phase=140&el=0$X" --out shots/uranus/${P}_crescent.png &
wait
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=1.2&phase=40&el=0&fov=50$X" --out shots/uranus/${P}_limb.png &
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&dist=2.2&phase=20&el=30&fov=40$X" --out shots/uranus/${P}_ringsclose.png &
node tools/shot.mjs --hud 0 --q "view=body&body=uranus&target=miranda&dist=3&phase=50$X" --out shots/uranus/${P}_miranda.png &
wait
