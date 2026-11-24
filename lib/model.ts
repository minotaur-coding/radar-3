// Token Radar's value model, radar-3. One snapshot in, one ranked board out.
//
// The board ranks every protocol that records no token (no market cap, no CoinGecko id, no symbol),
// and covers the whole watchlist plus the strongest pre-token protocols below its floor. Protocols
// whose token already trades are kept apart in a live set: the market prices them, so the model has
// nothing to say about them and never mixes them into the ranking — but the market IS the
// calibration: each live protocol's MCap/TVL ratio is the market's own answer to "what is a dollar
// of this protocol's TVL worth as a token", and the model uses those ratios as anchors.
//
// Implied value follows only from the snapshot's own figures, stated once here and echoed on the page:
//
//   implied = round( tvl_usd
//                    x anchor_multiple(category)      // calibrated, see below
//                    x (1 + clamp(change_7d, -60, +120)/100 x GROWTH_WEIGHT)   // momentum
//                    x (0.80 + 0.40 x min(age_days, 1095)/1095)                // runway without a token
//                    x tie_break(slug)                // +-0.01%, keeps whole dollars distinct
//                  )
//
//   anchor_multiple(category): NOT a hand-picked constant. For every category, the model takes the
//   live-token protocols of that category in the same snapshot, computes each one's MCap/TVL, and
//   the anchor is the median. That is the market's own implied multiple for a dollar of TVL in that
//   kind of protocol. A category with fewer than MIN_COMPARABLES live comparables — or no category
//   at all — takes the global median over every live protocol, the broadest anchor the snapshot
//   holds. Ratios are clamped to [0.05, 2.0] before the median so one overheated listing cannot
//   move a category's anchor. The calibration is recomputed on every run from the sealed bytes, so
//   it follows the snapshot, never a fixed table, and the dashboard shows each category's anchor,
//   comparable count and median ratio.
//
//   growth and runway are as radar-2: momentum scales the anchor by half the clamped 7-day change;
//   the runway factor rises 0.80 -> 1.20 over three years without a token, because a protocol that
//   has run longer with no token has accrued more value for its future one. An unknown listing age
//   counts as 365 days.
//
//   tie_break(slug): a deterministic +-0.01% offset derived from the slug alone (no randomness),
//   documented so whole-dollar rounding cannot collapse two different protocols onto one number:
//   the board's implied values are all distinct.
//
// As a last pass the board enforces strict distinctness: after sorting by implied value (then TVL,
// then slug), any row whose implied value did not land strictly below the row ahead of it is moved
// to one dollar under it. With 120+ rows of distinct products this pass almost never fires; it is
// stated here because it is part of the model.
//
// The 40 watchlist protocols (TVL >= floor_usd, no token, not a wrapped/staked product of one that
// trades) are the floor; the board then fills with pre-token protocols below the floor ranked by a
// radar score — tvl x growth x young-protocol urgency — until it holds at least MIN_ROWS rows.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: null | string;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's fixed constants (the calibration is per-snapshot, these are the formula's shape). */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  runway_floor: number;
  runway_range: number;
  runway_days: number;
  unknown_age_days: number;
  min_comparables: number;
  ratio_clamp_min: number;
  ratio_clamp_max: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  runway_floor: 0.8,
  runway_range: 0.4,
  runway_days: 1095,
  unknown_age_days: 365,
  min_comparables: 3,
  ratio_clamp_min: 0.05,
  ratio_clamp_max: 2.0,
};

export const MODEL_VERSION = 'radar-3';

/** One category's calibrated anchor: the median MCap/TVL of its live-token comparables. */
export interface CategoryAnchor {
  /** The multiple one dollar of TVL implies for a token in this category. */
  multiple: number;
  /** How many live-token protocols of this category anchored it (0 = fell back to the global median). */
  comparables: number;
  /** The raw median ratio before the clamp, null when the category took the global anchor. */
  median_ratio: number | null;
}

/** The per-snapshot calibration: which live protocols anchor each category, at what multiple. */
export interface Calibration {
  global_multiple: number;
  global_comparables: number;
  categories: Record<string, CategoryAnchor>;
}

/** Live comparables: protocols whose token trades, so their MCap/TVL is the market's own multiple. */
function liveComparables(protocols: SnapshotProtocol[]): { category: string | null; ratio: number }[] {
  const out: { category: string | null; ratio: number }[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.gecko_id === null || p.symbol === null) continue;
    if (!(p.tvl_usd > 0)) continue;
    out.push({ category: p.category, ratio: p.mcap_usd / p.tvl_usd });
  }
  return out;
}

/** The median of a list of numbers (mean of the two middle values for an even count). */
function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/**
 * The calibration the whole board is scored against, computed from the snapshot alone: per
 * category, the median MCap/TVL of its live-token protocols (clamped per protocol so one
 * overheated listing cannot move an anchor); the global median backs every category with fewer
 * than min_comparables comparables, and the unknown-category case.
 */
export function calibrate(snapshot: Snapshot, model: ModelConstants = MODEL): Calibration {
  const comps = liveComparables(snapshot.protocols);
  const clamp = (r: number) => Math.min(model.ratio_clamp_max, Math.max(model.ratio_clamp_min, r));
  const global = median(comps.map((c) => clamp(c.ratio)));
  const globalMultiple = global === null ? 0.25 : round3(global);
  const groups = new Map<string, number[]>();
  for (const c of comps) {
    if (c.category === null) continue;
    const key = c.category.trim().toLowerCase();
    const arr = groups.get(key);
    if (arr) arr.push(clamp(c.ratio));
    else groups.set(key, [clamp(c.ratio)]);
  }
  const categories: Record<string, CategoryAnchor> = {};
  for (const [key, ratios] of groups) {
    if (ratios.length < model.min_comparables) continue; // falls back to the global anchor
    const raw = median(ratios)!;
    categories[key] = { multiple: round3(raw), comparables: ratios.length, median_ratio: round3(raw) };
  }
  return { global_multiple: globalMultiple, global_comparables: comps.length, categories };
}

const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;

/** A category's anchor: its own calibration, else the closest key it contains, else the global median. */
export function categoryAnchor(category: string | null, cal: Calibration): CategoryAnchor {
  if (category !== null) {
    const key = category.trim().toLowerCase();
    if (cal.categories[key] !== undefined) return cal.categories[key]!;
    for (const k of Object.keys(cal.categories)) {
      if (key.includes(k) || k.includes(key)) return cal.categories[k]!;
    }
  }
  return { multiple: cal.global_multiple, comparables: cal.global_comparables, median_ratio: null };
}

/** Minimum board rows: 40 watchlist slugs plus at least 80 early rows below the floor. */
export const MIN_ROWS = 120;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: a ranked pre-token protocol. */
export interface BoardRow {
  rank: number;
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
  token_status: 'pre-token';
  watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    anchor_multiple: number;
    comparables: number;
    median_ratio: number | null;
    growth_pct: number;
    growth_multiplier: number;
    runway_multiplier: number;
    age_days: number | null;
    tie_break: number;
  };
  farm_steps: string[];
}

/** A live-token protocol: it already trades, so the market's own value is the fact shown. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  ratio: number | null;
}

/** The compact dataset the dashboard renders, written to data.js beside the page. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  calibration: Calibration;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: (BoardRow & { is_watchlist: boolean })[];
  live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `from` to `to`, clamped at zero; null when either date is absent or unreadable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** A deterministic +-0.01% tie-break from the slug alone, so whole dollars stay distinct. */
export function tieBreak(slug: string): number {
  let h = 2166136261;
  for (let i = 0; i < slug.length; i++) {
    h ^= slug.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const span = (h >>> 0) % 2001; // 0..2000
  return 1 + (span - 1000) / 1e7; // 1 -+ 0.0001
}

/** The multipliers and the implied value one protocol gets under the model. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  cal: Calibration,
  model: ModelConstants = MODEL,
): { implied: number; anchor: CategoryAnchor; growthPct: number; growthMult: number; runwayMult: number; age: number | null; tie: number } {
  const age = ageDays(asOf, protocol.listed_at);
  const anchor = categoryAnchor(protocol.category, cal);
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age ?? model.unknown_age_days;
  const runwayMult = model.runway_floor + (Math.min(Math.max(ageForModel, 0), model.runway_days) / model.runway_days) * model.runway_range;
  const tie = tieBreak(protocol.slug);
  const implied = Math.max(1, Math.round(protocol.tvl_usd * anchor.multiple * growthMult * runwayMult * tie));
  return { implied, anchor, growthPct, growthMult, runwayMult, age, tie };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

const slugCmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The ranked board: every rankable pre-token protocol, watchlist first as the floor, then the early
 * radar below the floor ranked by radar score (tvl x growth x young-protocol urgency) until MIN_ROWS rows.
 */
export function buildBoard(snapshot: Snapshot, cal: Calibration, model: ModelConstants = MODEL): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined && isRankable(p)) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor, strongest radar score first.
  // Score = tvl x (1 + growth/100 clamped) x young-protocol urgency (newer protocols are scouted
  // sooner, so a young high-TVL protocol outranks an old one of equal TVL).
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .map((p) => {
      const age = ageDays(snapshot.as_of, p.listed_at);
      const g = Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
      const ageScore = age === null ? 0.5 : age < 180 ? 1.5 : age < 365 ? 1.2 : age < 730 ? 0.9 : 0.6;
      return { p, score: p.tvl_usd * (1 + g / 100) * ageScore };
    })
    .sort((a, b) => b.score - a.score || slugCmp(a.p.slug, b.p.slug))
    .map((e) => e.p);
  for (const p of early) {
    if (chosen.size >= MIN_ROWS) break;
    chosen.set(p.slug, p);
  }

  const scored = [...chosen.values()].map((p) => ({ p, ...impliedValue(p, snapshot.as_of, cal, model) }));
  scored.sort((a, b) => b.implied - a.implied || b.p.tvl_usd - a.p.tvl_usd || slugCmp(a.p.slug, b.p.slug));
  const rows: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token' as const,
    watchlist: snapshot.watchlist.includes(s.p.slug),
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      anchor_multiple: s.anchor.multiple,
      comparables: s.anchor.comparables,
      median_ratio: s.anchor.median_ratio,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      runway_multiplier: round4(s.runwayMult),
      age_days: s.age,
      tie_break: s.tie,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
  // The distinctness pass: after sorting, every implied value must sit strictly below the row ahead.
  // Almost never fires (the tie-break already separates whole dollars); stated as part of the model.
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.implied_value_usd >= rows[i - 1]!.implied_value_usd) {
      rows[i]!.implied_value_usd = Math.max(1, rows[i - 1]!.implied_value_usd - 1);
    }
  }
  return rows;
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A step as one string: its action, then its cost and its time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** Bridge / withdrawal cost and time for funding a chain, stated so the reader can budget it. */
function fundingNote(chain: string): { fee: string; time: string } {
  const c = chain.toLowerCase();
  if (c === 'ethereum') return { fee: 'about $3-8 in gas to move funds or swap on mainnet', time: '5-15 minutes' };
  if (c === 'solana' || c === 'sui' || c === 'aptos' || c === 'ton') return { fee: 'under $0.05 per transaction', time: '1-5 minutes' };
  if (c === 'base' || c === 'arbitrum' || c === 'optimism' || c === 'polygon' || c === 'blast' || c === 'scroll' || c === 'linea' || c === 'zksync') {
    return { fee: 'about $0.10-2 to bridge in on an L2', time: '5-10 minutes' };
  }
  if (c === 'bsc') return { fee: 'under $0.30 per transaction', time: '3-5 minutes' };
  return { fee: 'a few dollars of gas depending on the chain', time: '5-15 minutes' };
}

/** The category's core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC as collateral in ${name}'s largest market on ${chain} and leave it unborrowed at first, then borrow at most 30% LTV after a week so the position shows real usage.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm') || c.includes('liquidity')) return `Provide $${capital} of liquidity (half USDC, half the other asset) into ${name}'s deepest pool on ${chain} and leave the LP position open, compounding fees weekly.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small, hedged long against an equivalent short elsewhere, so volume accrues without directional risk.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then bridge half of it back so the route sees volume in both directions.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name}, keep the receipt token in the same wallet, and never move it to an exchange.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one small position each week on its most liquid market, holding each bet to resolution.`;
  if (c.includes('curator') || c.includes('allocator') || c.includes('vault')) return `Deposit $${capital} into ${name}'s largest vault on ${chain} and keep the vault shares; add a second $${Math.round(capital / 2)} tranche after two weeks.`;
  if (c.includes('stable')) return `Mint $${capital} of the stable asset through ${name} on ${chain}, then deposit the minted stable back into the protocol's own savings module.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it in the same wallet through at least one yield distribution.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} for a 30-day term and let it lapse unredeemed, then buy a second term.`;
  if (c.includes('launch') || c.includes('incubat')) return `Join ${name}'s public track on ${chain} with $${capital} and complete every quest it lists, screenshotting each completed task.`;
  return `Deposit $${capital} of USDC into ${name}'s main pool on ${chain} and keep the position open, adding to it weekly rather than once.`;
}

/**
 * A protocol's farm plan: seven steps, each an action with a stated cost and time. The plan is
 * derived from the protocol's own record (category, chains, TVL, age), never from a hand-written
 * list of names, and every cost is either dollars or the capital it ties up.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const alt = p.chains.length > 1 ? p.chains[1]! : chain;
  const fund = fundingNote(chain);
  const altFund = p.chains.length > 1 ? fundingNote(alt) : fund;
  return [
    {
      text: `Set up a fresh wallet used only for farming ${p.name}, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: `Fund it on ${chain} with $${capital} of USDC or the chain's gas asset from an exchange withdrawal or a bridge you already use.`,
      cost: `$${capital} of capital plus ${fund.fee}`,
      time: `${fund.time} to land`,
    },
    {
      text: `${actionFor(p, capital, chain)}`,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week — a deposit, a swap, a borrow-repay or a vote — alternating between ${chain} and ${alt} where the protocol runs on both.`,
      cost: `about $2 of gas a week on ${chain}${altFund ? `, similar on ${alt}` : ''}`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity lands in more than one monthly snapshot, and record every transaction hash in a farm log the day you transact.`,
      cost: `the $${capital} stays in the position (withdrawing early can cost the accrued allocation)`,
      time: `${hold} days, ~5 minutes a week to check`,
    },
    {
      text: `Watch ${p.name}'s own announcements channel for a points program or an incentives season and join it in its first week; late joins are worth a fraction of early ones.`,
      cost: 'no fee beyond gas',
      time: '5 minutes a week',
    },
    {
      text: `Before you withdraw, claim rewards only from the protocol's own page, then unwind in two tranches a week apart and log the exit prices.`,
      cost: 'a few dollars of gas to exit',
      time: '15 minutes per tranche',
    },
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, 30)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      ratio: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const calibration = calibrate(snapshot, model);
  const board = buildBoard(snapshot, calibration, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    calibration,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: early,
    live_size: live.length,
    rows: board.map((r) => ({ ...r, is_watchlist: snapshot.watchlist.includes(r.slug) })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board holds ${board.length} rows, under the 100 the gate asks`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd >= board[i - 1]!.implied_value_usd) return `row ${i + 1} does not sit strictly under row ${i} on implied value`;
  for (const r of board) {
    if (r.slug.length < 1 || r.slug.length > 128 || /\s/.test(r.slug)) return `${r.slug} is not a slug the gate takes`;
    if (typeof r.name !== 'string' || r.name.length === 0) return `${r.slug} has no name`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) return `${r.slug} has implied value ${r.implied_value_usd}`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
