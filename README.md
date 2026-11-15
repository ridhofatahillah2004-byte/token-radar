[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ridhofatahillah2004-byte/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ridhofatahillah2004-byte/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

# Token launch radar

Ranks pre-token protocols by implied launch value, with a farm plan for each. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## Run

mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>

The program reads a sealed DefiLlama snapshot, writes board.json, the dashboard and dossier.json to the output directory. Node 22, standard library only, no network, deterministic.

## Bounty

https://make.fun/bounty/token-radar-01
