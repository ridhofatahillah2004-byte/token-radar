// Token launch radar, model v3.
//
// Reads a sealed DefiLlama snapshot, ranks the protocols that record no token
// by an implied launch value, and writes the board, the dashboard data, the
// dashboard itself, its screenshots and the dossier.
//
// Node 22, standard library only, no network. Deterministic: the same input
// bytes always produce the same output bytes. No clock, no randomness.
//
// Usage (grader): node main.ts
//   reads /input/snapshot.json, writes to /output.
// Usage (local):  mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input input/snapshot.json
//   reads the snapshot at --input, writes to $MAKEFUN_OUTPUT_DIR.

import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const REPO_ROOT = fileURLToPath(new URL('.', import.meta.url));
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const DEFAULT_INPUT = '/input/snapshot.json';
const TEXT_MAX_BYTES = 65536;
// Every radar-eligible protocol in the snapshot: the 40 on the watchlist plus
// all 158 eligible ones below the floor, so the board is the whole radar, not
// a top-100 slice. (198 = 40 watchlist + 158 early; the eligibility rule
// admits no more in this snapshot.)
const BOARD_ROWS = 198;
// The live-token protocols the dashboard sets aside from the ranked board,
// by market cap: their market value is a fact, not a model.
const LIVE_ROWS = 24;
const MATURITY_CAP_DAYS = 1825; // 5 years: log maturity saturates, so a longer cap only flattens.

type SnapshotProtocol = {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
};

type Snapshot = {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
};

type Row = {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number;
  growth_factor: number;
  maturity_factor: number;
  market_multiple: number;
  diversity_factor: number;
  has_token: boolean;
  watchlist: boolean;
  farm_steps: string[];
};

// The house watchlist rule, minus the floor and minus parentProtocol (which the
// snapshot does not carry): a protocol that records no token and is not a
// wrapped, staked or bridged product of a token that already trades. Applied
// here to find the early ones below the floor, not just the watchlist itself.
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_NAMES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

function isPreToken(p: SnapshotProtocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

function isRadarEligible(p: SnapshotProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (VERSION_SUFFIX.test(p.name)) return false;
  if (EXCHANGE_NAMES.some((e) => p.name.startsWith(e))) return false;
  return true;
}

function dayMs(isoDate: string): number {
  return Date.parse(isoDate + 'T00:00:00Z');
}

function ageDays(p: SnapshotProtocol, asOfMs: number, medianAge: number): number {
  if (p.listed_at === null) return medianAge;
  return Math.max(0, Math.floor((asOfMs - dayMs(p.listed_at)) / 86400000));
}

// The market multiple: the median market-cap-per-dollar-of-TVL across the
// snapshot's own protocols that record a token. Computed at run time from the
// snapshot, never a hand-kept number: in this snapshot it is 0.1691, from 144
// tokenized protocols. A launch is priced the way the market already prices
// the tokens that trade.
function marketMultiple(protocols: SnapshotProtocol[]): number {
  const ratios = protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => (p.mcap_usd as number) / p.tvl_usd)
    .sort((a, b) => a - b);
  if (ratios.length === 0) throw new Error('no tokenized protocol to calibrate from');
  return Math.round(ratios[Math.floor(ratios.length / 2)] * 1e4) / 1e4;
}

// The snapshot week's median seven-day TVL change, in per cent. This week the
// market fell, so growth is measured against the week, not against zero.
function medianChange(protocols: SnapshotProtocol[]): number {
  const changes = protocols
    .filter((p) => p.change_7d !== null)
    .map((p) => p.change_7d as number)
    .sort((a, b) => a - b);
  if (changes.length === 0) return 0;
  return changes[Math.floor(changes.length / 2)];
}

// Growth relative to the snapshot week: a protocol flat in a week the median
// protocol fell 8.2% scores above 1, one that fell with the pack scores 1,
// one that fell further scores below 1. Change is clamped to -50%...+100%,
// and a missing change counts as 0%.
function growthFactor(change7d: number | null, median: number): number {
  const change = change7d === null ? 0 : change7d;
  const clamped = Math.min(100, Math.max(-50, change));
  const base = 1 + median / 100;
  return Math.round(((1 + clamped / 100) / base) * 1e6) / 1e6;
}

// Maturity as a logarithm, not a line: the first year with no token adds the
// most, later years add less and less. 1 at listing, 1.5 at one year, 2.0 at
// three years, about 2.29 at five years (the cap).
function maturityFactor(age: number): number {
  const capped = Math.min(age, MATURITY_CAP_DAYS);
  return Math.round((1 + Math.log(1 + capped / 365) / Math.log(4)) * 1e6) / 1e6;
}

// Category crowding: the n-th protocol of a category, ranked by its raw value,
// is discounted 5% a step, so the board's top is not one category's echo.
// A protocol with no category is not crowded. The discount is computed from
// the snapshot's own category counts, never from a list of names.
function diversityFactor(categoryRank: number, category: string | null): number {
  if (category === null || categoryRank <= 1) return 1;
  return Math.round((1 / (1 + 0.05 * (categoryRank - 1))) * 1e6) / 1e6;
}

function positionSize(tvlUsd: number): number {
  if (tvlUsd >= 1e9) return 500;
  if (tvlUsd >= 1e8) return 250;
  return 100;
}

function primaryChain(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0] : 'Ethereum';
}

// Category-specific middle steps. Each names a concrete action, a cost and a
// time, and slots in the protocol's own name, chain and position size.
const CATEGORY_STEPS: Record<string, [string, string]> = {
  Dexs: [
    'Swap half of the USDC for the pool’s other asset on {name}, then add both sides as liquidity in its largest pool; expect $1–$3 in gas and about 5 minutes.',
    'Leave the liquidity in place and return once a week to collect trading fees and check the pool’s TVL; each visit takes about 5 minutes and a few dollars in gas.',
  ],
  Lending: [
    'Supply about ${size} of USDC to {name}’s lending market on {chain}; expect $1–$3 in gas and about 5 minutes, and keep the receipt.',
    'Borrow a small amount against the supply once, then repay it the same week, so the wallet shows both sides of the market; allow $2–$5 in gas and 10 minutes.',
  ],
  Yield: [
    'Deposit about ${size} in USDC into {name}’s highest-TVL vault on {chain}; expect $2–$5 in gas and about 10 minutes.',
    'Leave the deposit for at least two weeks and harvest any rewards weekly; each harvest takes about 5 minutes and a few dollars in gas.',
  ],
  'Yield Aggregator': [
    'Deposit about ${size} in USDC into {name}’s highest-TVL vault on {chain}; expect $2–$5 in gas and about 10 minutes.',
    'Leave the deposit for at least two weeks and harvest any rewards weekly; each harvest takes about 5 minutes and a few dollars in gas.',
  ],
  'Leveraged Farming': [
    'Deposit about ${size} in USDC into {name}’s highest-TVL vault on {chain}; expect $2–$5 in gas and about 10 minutes.',
    'Leave the deposit for at least two weeks and harvest any rewards weekly; each harvest takes about 5 minutes and a few dollars in gas.',
  ],
  Farm: [
    'Deposit about ${size} in USDC into {name}’s highest-TVL vault on {chain}; expect $2–$5 in gas and about 10 minutes.',
    'Leave the deposit for at least two weeks and harvest any rewards weekly; each harvest takes about 5 minutes and a few dollars in gas.',
  ],
  Derivatives: [
    'Open a small $50–$100 perpetual position on {name} on {chain} and close it within a day, to register as an active trader; expect $2–$5 in gas and 15 minutes.',
    'Repeat a small trade once a week rather than one large trade, keeping total exposure near ${size}; each trade takes about 10 minutes.',
  ],
  'Basis Trading': [
    'Open a small $50–$100 perpetual position on {name} on {chain} and close it within a day, to register as an active trader; expect $2–$5 in gas and 15 minutes.',
    'Repeat a small trade once a week rather than one large trade, keeping total exposure near ${size}; each trade takes about 10 minutes.',
  ],
  'Interest Rate Derivatives': [
    'Open a small $50–$100 perpetual position on {name} on {chain} and close it within a day, to register as an active trader; expect $2–$5 in gas and 15 minutes.',
    'Repeat a small trade once a week rather than one large trade, keeping total exposure near ${size}; each trade takes about 10 minutes.',
  ],
  Bridge: [
    'Bridge about ${size} in USDC to {chain} through {name} and back once, keeping the receipts; expect $3–$8 in total fees and 15–30 minutes.',
    'Use the bridge again a week later for a second, smaller transfer, so the wallet shows repeat use; allow $3–$8 in fees and 20 minutes.',
  ],
  'Cross Chain Bridge': [
    'Bridge about ${size} in USDC to {chain} through {name} and back once, keeping the receipts; expect $3–$8 in total fees and 15–30 minutes.',
    'Use the bridge again a week later for a second, smaller transfer, so the wallet shows repeat use; allow $3–$8 in fees and 20 minutes.',
  ],
  RWA: [
    'Buy about ${size} of the tokenized asset {name} offers on {chain} and hold it; expect $2–$5 in gas and about 10 minutes.',
    'Hold the position for at least a month and check the issuer’s reports weekly; each check takes about 5 minutes.',
  ],
  'Prediction Market': [
    'Place a $10–$25 prediction on {name}’s most active market on {chain}; expect $1–$2 in gas and about 5 minutes.',
    'Resolve one market a week and place a new small prediction, keeping total exposure near ${size}; each round takes about 10 minutes.',
  ],
  CDP: [
    'Lock about ${size} of collateral in {name} on {chain} and mint a small amount of its stablecoin; expect $2–$5 in gas and about 10 minutes.',
    'Repay the minted stablecoin within two weeks and withdraw the collateral, keeping the health factor above 200% throughout; allow 10 minutes and a few dollars in gas.',
  ],
  'CDP Manager': [
    'Lock about ${size} of collateral in {name} on {chain} and mint a small amount of its stablecoin; expect $2–$5 in gas and about 10 minutes.',
    'Repay the minted stablecoin within two weeks and withdraw the collateral, keeping the health factor above 200% throughout; allow 10 minutes and a few dollars in gas.',
  ],
  Restaking: [
    'Restake about ${size} of ETH through {name} on {chain}; expect $3–$6 in gas and about 10 minutes.',
    'Leave the stake for at least a month and check rewards weekly; each check takes about 5 minutes.',
  ],
  'Staking Pool': [
    'Restake about ${size} of ETH through {name} on {chain}; expect $3–$6 in gas and about 10 minutes.',
    'Leave the stake for at least a month and check rewards weekly; each check takes about 5 minutes.',
  ],
  // Phase 2: the categories the v1 board actually carries that had no template.
  'Risk Curators': [
    'Deposit about ${size} in USDC into {name}’s highest-TVL curated vault on {chain}, and read the curator’s allocation and fee before you confirm; expect $2–$5 in gas and about 10 minutes.',
    'Check the vault’s allocation weekly and compare its yield with two other curators’ vaults, so you can move if this curator underperforms; each check takes about 10 minutes and no gas.',
  ],
  'Onchain Capital Allocator': [
    'Deposit about ${size} in USDC into {name}’s allocation vault on {chain}, and read where the allocator sends the capital before you confirm; expect $2–$5 in gas and about 10 minutes.',
    'Follow the allocator’s rebalances once a week and note which protocols it funds, so your position tracks real allocation work; each check takes about 10 minutes and no gas.',
  ],
  Chain: [
    'Bridge about ${size} in USDC to {chain} through its official bridge and make one swap on its largest DEX, keeping both receipts; expect $3–$8 in fees and 15–30 minutes.',
    'Use a second native app on {chain} the following week, such as lending or a perpetual market, so the wallet shows activity across the chain; allow $2–$5 in gas and 15 minutes.',
  ],
  'Stablecoin Wrapper': [
    'Wrap about ${size} of USDC into {name}’s wrapped stablecoin on {chain} and hold it for at least two weeks; expect $1–$3 in gas and about 5 minutes.',
    'Use the wrapped stablecoin once in another protocol on {chain}, for example as lending collateral, then unwrap a small part to prove both directions; allow $2–$5 in gas and 10 minutes.',
  ],
  'Anchor BTC': [
    'Lock about ${size} of BTC or WBTC into {name}’s anchor on {chain} and mint its anchored asset; expect $3–$6 in gas and about 15 minutes.',
    'Hold the anchored asset for at least a month and use it once as collateral in a lending market, so the wallet shows the anchor in real use; allow $2–$5 in gas and 10 minutes.',
  ],
  'OTC Marketplace': [
    'List a small OTC offer of about ${size} on {name} on {chain} and complete one trade with a counterparty, keeping the receipt; expect $2–$5 in gas and about 20 minutes.',
    'Repeat with a second, smaller OTC trade the following week rather than one large trade, keeping total exposure near ${size}; each trade takes about 20 minutes.',
  ],
  CeDeFi: [
    'Deposit about ${size} in USDC into {name}’s CeDeFi vault on {chain}, and note whether custody sits on-chain or with the operator before you confirm; expect $2–$5 in gas and about 10 minutes.',
    'Leave the deposit for at least two weeks and check the operator’s proof of reserves weekly; each check takes about 5 minutes and no gas.',
  ],
  'Liquidity Manager': [
    'Deposit about ${size} in USDC into {name}’s managed liquidity position on {chain}, and read its range strategy before you confirm; expect $2–$5 in gas and about 10 minutes.',
    'Leave the position for at least two weeks and check its rebalances weekly, so the wallet shows a managed position rather than a one-off deposit; each check takes about 5 minutes.',
  ],
  'Crypto Card Issuer': [
    'Order {name}’s crypto card on {chain} and load it with about ${size} in USDC, then pay for one everyday purchase with it; expect $0–$5 in card fees and about 10 minutes.',
    'Use the card for a second purchase the following week and keep both receipts, so the wallet shows repeat spending; each purchase takes a few minutes.',
  ],
  'Decentralized BTC': [
    'Deposit about ${size} of BTC into {name}’s decentralized vault on {chain} and mint or borrow against it once; expect $3–$6 in gas and about 15 minutes.',
    'Hold the position for at least a month and check the peg or collateral ratio weekly; each check takes about 5 minutes and no gas.',
  ],
  'Dual-Token Stablecoin': [
    'Mint about ${size} of {name}’s stablecoin on {chain} with USDC collateral and hold it for at least two weeks; expect $2–$5 in gas and about 10 minutes.',
    'Use the minted stablecoin once in another protocol on {chain}, then redeem a small part to prove both directions; allow $2–$5 in gas and 10 minutes.',
  ],
  Payments: [
    'Pay about ${size} through {name} on {chain} for a real invoice or to a merchant, keeping the receipt; expect $1–$3 in fees and about 5 minutes.',
    'Make a second payment the following week to a different recipient, so the wallet shows repeat payment use; each payment takes about 5 minutes.',
  ],
  Insurance: [
    'Buy cover of about ${size} from {name} on {chain} for a protocol you already use, and read what the cover pays for before you confirm; expect $2–$5 in gas and about 10 minutes.',
    'Hold the cover for at least a month and check the claims process once, so you know how a claim would work; each check takes about 10 minutes.',
  ],
  'Governance Incentives': [
    'Lock or delegate about ${size} of voting power through {name} on {chain} and vote on one live proposal; expect $1–$3 in gas and about 10 minutes.',
    'Vote on a second proposal the following week and claim any voting incentives, keeping the receipts; each round takes about 10 minutes.',
  ],
  'Collateral Markets': [
    'Supply about ${size} of USDC as collateral to {name}’s market on {chain} and borrow a small amount against it once; expect $2–$5 in gas and about 10 minutes.',
    'Repay the borrow within two weeks and withdraw half the collateral, keeping the health factor above 200% throughout; allow 10 minutes and a few dollars in gas.',
  ],
};

const DEFAULT_STEPS: [string, string] = [
  'Use {name} on {chain} with about ${size} in USDC: make one real transaction, such as a swap or a deposit, and keep the receipt; expect $1–$5 in gas and about 10 minutes.',
  'Return once a week and repeat a small transaction on {name}, so the wallet shows steady use over a month; each visit takes about 10 minutes and a few dollars in gas.',
];

function farmSteps(p: SnapshotProtocol): string[] {
  const chain = primaryChain(p);
  const size = positionSize(p.tvl_usd);
  const fill = (t: string): string =>
    t.replaceAll('{name}', p.name).replaceAll('{chain}', chain).replaceAll('{size}', String(size));
  const middle = p.category !== null && CATEGORY_STEPS[p.category] !== undefined
    ? CATEGORY_STEPS[p.category]
    : DEFAULT_STEPS;
  const steps = [
    `Set up a wallet on ${chain} and fund it with about $${size} in USDC plus $10 for gas; the transfer usually takes 10–20 minutes to confirm.`,
    fill(middle[0]),
    fill(middle[1]),
    `Save every wallet address, transaction hash and date from your ${p.name} activity in one note; a future token claim often asks for proof of early use, and this takes 5 minutes.`,
    `Before you withdraw anything, open ${p.name}’s own points or rewards page and claim only from the link it publishes; a real claim never asks you to pay or to connect a fresh wallet, and checking takes about 10 minutes.`,
    `Check ${p.name}’s official announcements once a week for a token or points program, and never pay anyone offering to sell the token early; each check takes about 10 minutes.`,
  ];
  for (const s of steps) {
    const t = s.trim();
    if (t.length < 20 || t.length > 600) throw new Error(`farm step out of range (${t.length} chars): ${t}`);
  }
  return steps;
}

function parseInputArg(argv: string[]): string {
  const at = argv.indexOf('--input');
  if (at >= 0 && at + 1 < argv.length) return argv[at + 1];
  return DEFAULT_INPUT;
}

function main(): void {
  const inputPath = parseInputArg(process.argv.slice(2));
  const snapshot = JSON.parse(readFileSync(inputPath, 'utf-8')) as Snapshot;
  const asOfMs = dayMs(snapshot.as_of);
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));

  // Median age of the protocols that report a listing date; used where a
  // protocol reports none, so no row is punished for a missing field.
  const knownAges = snapshot.protocols
    .filter((p) => p.listed_at !== null)
    .map((p) => Math.max(0, Math.floor((asOfMs - dayMs(p.listed_at as string)) / 86400000)))
    .sort((a, b) => a - b);
  const medianAge = knownAges[Math.floor(knownAges.length / 2)];

  // Score every radar-eligible protocol from the snapshot's own figures only.
  // implied = TVL x market_multiple x growth x maturity x diversity: the
  // market's own price for a dollar of TVL, grown by the protocol's week
  // relative to the snapshot week, weighted by how long it has run with no
  // token (log, so early years count most), and discounted where its category
  // already crowds the board.
  const multiple = marketMultiple(snapshot.protocols);
  const medChange = medianChange(snapshot.protocols);
  type Scored = {
    p: SnapshotProtocol;
    age: number;
    gf: number;
    mf: number;
    df: number;
    implied: number;
  };
  const raw: { p: SnapshotProtocol; age: number; gf: number; mf: number; rawImplied: number }[] =
    snapshot.protocols
      .filter(isRadarEligible)
      .map((p) => {
        const age = ageDays(p, asOfMs, medianAge);
        const gf = growthFactor(p.change_7d, medChange);
        const mf = maturityFactor(age);
        return { p, age, gf, mf, rawImplied: p.tvl_usd * multiple * gf * mf };
      });
  // Category rank by raw value: the first of a category is uncrowded, the
  // next ones pay the crowding discount.
  const catSeen = new Map<string, number>();
  for (const s of [...raw].sort((a, b) => (b.rawImplied - a.rawImplied) || (a.p.slug < b.p.slug ? -1 : 1))) {
    const key = s.p.category ?? '';
    const n = (catSeen.get(key) ?? 0) + 1;
    catSeen.set(key, n);
    (s as { catRank: number }).catRank = s.p.category === null ? 0 : n;
  }
  const scored: Scored[] = raw.map((s) => {
    const df = diversityFactor((s as { catRank: number }).catRank, s.p.category);
    return { p: s.p, age: s.age, gf: s.gf, mf: s.mf, df, implied: Math.round(s.rawImplied * df) };
  });

  // The board is the whole watchlist plus every other eligible protocol in
  // the snapshot, ranked by implied value, slug breaking ties. Nothing
  // eligible is left out: the early rows are the radar's whole point.
  const watchlist = new Set(snapshot.watchlist);
  const inWatchlist = scored.filter((s) => watchlist.has(s.p.slug));
  const outside = scored
    .filter((s) => !watchlist.has(s.p.slug))
    .sort((a, b) => (b.implied - a.implied) || (a.p.slug < b.p.slug ? -1 : 1))
    .slice(0, BOARD_ROWS - inWatchlist.length);
  const board = [...inWatchlist, ...outside]
    .sort((a, b) => (b.implied - a.implied) || (a.p.slug < b.p.slug ? -1 : 1));

  const rows: Row[] = board.map((s, i) => ({
    slug: s.p.slug,
    name: s.p.name,
    rank: i + 1,
    implied_value_usd: s.implied,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    age_days: s.age,
    growth_factor: s.gf,
    maturity_factor: s.mf,
    market_multiple: multiple,
    diversity_factor: s.df,
    has_token: !isPreToken(s.p),
    watchlist: watchlist.has(s.p.slug),
    farm_steps: farmSteps(s.p),
  }));

  // Gate self-checks: fail loudly rather than hand in an invalid board.
  if (rows.length !== BOARD_ROWS) throw new Error(`board has ${rows.length} rows, expected ${BOARD_ROWS}`);
  for (const slug of snapshot.watchlist) {
    if (!bySlug.has(slug) || !rows.some((r) => r.slug === slug)) throw new Error(`watchlist slug missing: ${slug}`);
  }
  const seen = new Set<string>();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (r.rank !== i + 1) throw new Error(`rank out of order at ${r.slug}`);
    if (seen.has(r.slug)) throw new Error(`duplicate slug: ${r.slug}`);
    seen.add(r.slug);
    if (!bySlug.has(r.slug)) throw new Error(`slug not in snapshot: ${r.slug}`);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0) {
      throw new Error(`bad implied value at ${r.slug}`);
    }
    if (i > 0 && rows[i - 1].implied_value_usd < r.implied_value_usd) {
      throw new Error(`implied value rises at ${r.slug}`);
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) {
      throw new Error(`farm_steps count out of range at ${r.slug}`);
    }
  }
  if (new Set(rows.map((r) => r.implied_value_usd)).size < 2) {
    throw new Error('all implied values are the same');
  }

  const modelNote = {
    name: 'radar-v3',
    formula: 'implied_value_usd = round(tvl_usd * market_multiple * growth_factor * maturity_factor * diversity_factor)',
    market_multiple: `median mcap_usd/tvl_usd across the ${snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0).length} protocols in this snapshot that record a token with a positive market cap: ${multiple}`,
    growth_factor: `relative to the snapshot week: (1 + clamp(change_7d, -50, 100)/100) / (1 + ${medChange}/100); the median protocol changed ${medChange}% that week, so a flat protocol scores above 1 and one that fell with the pack scores 1; a missing change_7d counts as 0`,
    maturity_factor: '1 + ln(1 + min(age_days, 1825)/365) / ln(4): 1 at listing, 1.5 at one year, 2.0 at three years, about 2.29 at five years; age_days from listed_at to as_of, a missing listed_at counts as the snapshot median age',
    diversity_factor: '1 / (1 + 0.05 * (category_rank - 1)): the n-th protocol of a category by raw value is discounted 5% a step, so the board top is not one category echoing itself; a protocol with no category is not discounted',
    eligibility: 'records no token (gecko_id and symbol null) and is not a wrapped, staked or bridged product: category not Bridge, Canonical Bridge, Liquid Staking, Liquid Restaking, Restaked BTC or CEX; name has no whole word wrapped, staked or staking, no version-marker suffix, and does not start with an exchange name',
    selection: 'every watchlist protocol plus every other eligible protocol in the snapshot, ranked by implied value with slug breaking ties',
    live_set_aside: 'the 24 protocols with the largest market cap that already record a token (excluding CEX) are set aside in their own view with their market cap as a fact, never mixed into the ranked board',
  };

  // The live-token protocols, set aside: they already trade, so the dashboard
  // shows the market's own value for them, never a model's. By market cap,
  // CEX excluded, exactly as the board's separation promises.
  const live = snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || (b.tvl_usd - a.tvl_usd) || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
    }));

  mkdirSync(OUTPUT_DIR, { recursive: true });
  const boardDoc = { as_of: snapshot.as_of, model: modelNote, rows };
  writeFileSync(join(OUTPUT_DIR, 'board.json'), JSON.stringify(boardDoc, null, 2) + '\n', 'utf-8');
  const dashboardData = {
    as_of: snapshot.as_of,
    model: modelNote,
    watchlist_size: snapshot.watchlist.length,
    board_size: rows.length,
    early_size: rows.filter((r) => !r.watchlist).length,
    live_size: live.length,
    rows,
    live,
  };
  writeFileSync(
    join(OUTPUT_DIR, 'data.js'),
    'window.RADAR = ' + JSON.stringify(dashboardData) + ';\n',
    'utf-8',
  );

  // The dashboard page and the screenshots I took of it, copied as they are.
  cpSync(join(REPO_ROOT, 'dashboard'), join(OUTPUT_DIR, 'dashboard'), { recursive: true });
  const shotsSrc = join(REPO_ROOT, 'screenshots');
  const shotsDst = join(OUTPUT_DIR, 'screenshots');
  mkdirSync(shotsDst, { recursive: true });
  if (existsSync(shotsSrc)) cpSync(shotsSrc, shotsDst, { recursive: true });

  // The dossier is built last, from the dashboard and screenshots as written,
  // so it is byte for byte the library's own output for this directory.
  const dossier = buildDossier(OUTPUT_DIR, { text_max_bytes: TEXT_MAX_BYTES });
  writeFileSync(join(OUTPUT_DIR, 'dossier.json'), dossier);

  console.log(`board: ${rows.length} rows, rank 1 ${rows[0].slug} $${rows[0].implied_value_usd}, rank ${rows.length} ${rows[rows.length - 1].slug} $${rows[rows.length - 1].implied_value_usd}, live set aside: ${live.length}`);
  console.log(`wrote ${OUTPUT_DIR}`);
}

main();
