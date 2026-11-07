#!/bin/sh
# Wave-2 before/after view set (the critic's required views plus close-ups of the limb and the moons).
# usage (from the project root): sh src/bodies/uranus/tools/w2views.sh <out dir> [extra query]
D=${1:-shots/uranus/w2}
X=${2:-&only=uranus,sky,post}
mkdir -p "$D"
B="view=body&body=uranus"
s() { node tools/shot.mjs --hud 0 --q "$B&$2$X" --out "$D/$1.png" 2>&1 | grep -iE "error|warn|failed|NaN" ; }
s a_d3p20 "dist=3&phase=20" &
s b_d6p10e60 "dist=6&phase=10&el=60" &
s c_d16p60 "dist=1.6&phase=60" &
wait
s d_d22p150 "dist=2.2&phase=150" &
s e_miranda "target=miranda&dist=3&phase=50" &
s f_ringsclose "dist=2.2&phase=20&el=30&fov=40" &
wait
s g_ariel "target=ariel&dist=3&phase=50" &
s h_limb "dist=1.2&phase=40&el=0&fov=50" &
s i_crescent "dist=4&phase=140&el=0" &
wait
s j_mirclose "target=miranda&dist=1.3&phase=50" &
s k_bullseye "dist=5&phase=10&el=5" &
s l_ringzoom "dist=2.2&phase=110&el=54&look=17,-56&fov=12" &
wait
s m_mirterm "target=miranda&dist=1.6&phase=85" &
s n_titania "target=titania&dist=3&phase=50" &
s o_oberon "target=oberon&dist=3&phase=50" &
wait
s p_umbriel "target=umbriel&dist=3&phase=50" &
s q_skim "dist=1.05&phase=60&el=20&fov=50" &
wait
