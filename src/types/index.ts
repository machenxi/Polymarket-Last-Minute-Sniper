// ─────────────────────────────────────────────────────────────────────────────
// Polymarket Last-Minute Sniper – Core TypeScript Interfaces
// ─────────────────────────────────────────────────────────────────────────────

// ── Market ───────────────────────────────────────────────────────────────────

export type MarketWindow = '5m' | '15m';
export type TradeSide = 'YES' | 'NO';
export type OrderStatus = 'PENDING' | 'FILLED' | 'CANCELLED' | 'STALE';
export type PositionStatus = 'OPEN' | 'CLOSED' | 'EXPIRED';
export type SignalStrength = 'WEAK' | 'MODERATE' | 'HIGH';

export interface GammaMarket {
  id: string;
  question: string;
  slug: string;
  closed: boolean;
  endDate: string;
  bestBid?: number;
  bestAsk?: number;
  volume?: number;
  liquidity?: number;
  outcomePrices?: string;    // JSON array string e.g. "[0.65, 0.35]"
  outcomes?: string;         // JSON array string e.g. '["YES","NO"]'
  tokenIds?: string[];
  tags?: Array<{ id: string; label: string }>;
}

export interface ParsedMarket {
  id: string;
  question: string;
  slug: string;
  window: MarketWindow;
  endTime: Date;
  remainingSecs: number;
  yesPrice: number;
  noPrice: number;
  spread: number;
  liquidity: number;
  volume: number;
  yesTokenId: string;
  noTokenId: string;
}

// ── BTC Price ────────────────────────────────────────────────────────────────

export interface BtcPriceSnapshot {
  price: number;
  timestamp: number;         // Unix ms
}

export interface BtcPriceState {
  current: number;
  openPrice: number;         // BTC price when this market round started
  movePct: number;           // (current - open) / open * 100
  sustainedSinceMs: number | null; // when the qualifying move first started
  history: BtcPriceSnapshot[];
}

// ── Signal ───────────────────────────────────────────────────────────────────

export interface SniperSignal {
  marketId: string;
  slug: string;
  side: TradeSide;
  strength: SignalStrength;
  yesPrice: number;
  spread: number;
  movePct: number;
  sustainedMs: number;
  timestamp: number;
  reason: string;
}

export type SignalRejectReason =
  | 'TOO_EARLY'
  | 'INSUFFICIENT_MOVE'
  | 'MOVE_NOT_SUSTAINED'
  | 'SPREAD_TOO_WIDE'
  | 'LOW_LIQUIDITY'
  | 'PRICE_THRESHOLD_MISS'
  | 'DUPLICATE_POSITION'
  | 'MAX_POSITIONS_REACHED'
  | 'DAILY_LOSS_LIMIT'
  | 'NO_ACTIVE_MARKET';

// ── Order ────────────────────────────────────────────────────────────────────

export interface PlaceOrderRequest {
  marketId: string;
  side: TradeSide;
  amount: number;
  price?: number;            // limit price; undefined = market order
  isAggressive: boolean;
}

export interface PlaceOrderResponse {
  orderId: string;
  marketId: string;
  side: TradeSide;
  amount: number;
  price: number;
  status: OrderStatus;
  createdAt: number;
  filledAt?: number;
  txHash?: string;
}

export interface SimmerTradeRequest {
  market_id: string;
  side: 'YES' | 'NO';
  amount: number;
  venue: 'polymarket';
  source: string;
  wallet_address?: string;
}

export interface SimmerTradeResponse {
  id: string;
  status: string;
  market_id: string;
  side: string;
  amount: number;
  price?: number;
  tx_hash?: string;
  error?: string;
}

export interface SimmerImportRequest {
  polymarket_url: string;
}

export interface SimmerMarket {
  id: string;
  slug: string;
  question: string;
  yes_price: number;
  no_price: number;
  liquidity: number;
}

export interface SimmerPortfolio {
  balance: number;
  equity: number;
  positions: SimmerPosition[];
}

export interface SimmerPosition {
  market_id: string;
  side: string;
  shares: number;
  avg_price: number;
  current_price: number;
  pnl: number;
}

// ── Position ─────────────────────────────────────────────────────────────────

export interface ActivePosition {
  id: string;
  marketId: string;
  slug: string;
  side: TradeSide;
  amount: number;
  entryPrice: number;
  currentPrice: number;
  openedAt: number;
  expiresAt: number;
  status: PositionStatus;
  orderId: string;
  pnl?: number;
  closedAt?: number;
}

// ── Risk ─────────────────────────────────────────────────────────────────────

export interface RiskState {
  bankroll: number;
  dailyPnl: number;
  dailyTrades: number;
  openPositions: number;
  dailyStopHit: boolean;
  lastResetDate: string;     // YYYY-MM-DD
}

export interface PositionSizeResult {
  amount: number;
  pct: number;
  reason: string;
}

// ── Analytics ────────────────────────────────────────────────────────────────

export interface TradeRecord {
  id: string;
  marketId: string;
  slug: string;
  window: MarketWindow;
  side: TradeSide;
  entryPrice: number;
  exitPrice?: number;
  amount: number;
  pnl?: number;
  won?: boolean;
  openedAt: number;
  closedAt?: number;
  holdMs?: number;
  signalStrength: SignalStrength;
  movePct: number;
  minuteBucket: number;       // 0–4 for 5m, 0–14 for 15m
}

export interface MinuteBucketStats {
  bucket: number;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  avgPnl: number;
}

export interface DashboardSnapshot {
  asOf: string;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalPnl: number;
  roi: number;
  avgHoldMs: number;
  avgHoldSec: number;
  bankroll: number;
  dailyPnl: number;
  byMinuteBucket: MinuteBucketStats[];
  bySignalStrength: Record<SignalStrength, { trades: number; wins: number; pnl: number }>;
  recentTrades: TradeRecord[];
}

// ── Config ───────────────────────────────────────────────────────────────────

export interface SniperConfig {
  // Timing
  entryWindowSecs: number;       // default 45 – enter only in last N seconds
  sustainedMoveSecs: number;     // default 10 – move must last this long
  exitBeforeExpirySecs: number;  // default 5

  // Signal thresholds
  minMovePct: number;            // default 0.20
  yesMaxForBuyYes: number;       // default 0.72
  yesMinForBuyNo: number;        // default 0.30

  // Market quality
  maxSpread: number;             // default 0.03
  minLiquidity: number;          // default 50

  // Order execution
  limitOrderTtlMs: number;       // default 2000 – cancel stale limit after this
  aggressiveFillThreshold: SignalStrength; // 'HIGH' = use market order

  // Risk
  maxOpenPositions: number;      // default 1
  dailyStopLossPct: number;      // default 0.10 (10% of bankroll)
  baseBetPct: number;            // default 0.02 (2% of bankroll)
  maxBetPct: number;             // default 0.05 (5% of bankroll)

  // Markets
  windows: MarketWindow[];       // ['5m', '15m']
  asset: string;                 // 'BTC'
  pollIntervalMs: number;        // default 2000

  // Mode
  dryRun: boolean;
  logLevel: string;
}
