import dotenv from 'dotenv';
import type { SniperConfig, SignalStrength, MarketWindow } from '../types/index';

dotenv.config();

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required environment variable: ${key}`);
  return val;
}

function optionalEnv(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export interface AppEnv {
  privateKey: string;
  walletAddress: string;
  simmerApiKey: string;
  simmerBaseUrl: string;
  binanceWsUrl: string;
  binanceSymbol: string;
  analyticsFile: string;
}

export function loadEnv(): AppEnv {
  const privateKey = requireEnv('PRIVATE_KEY');
  const walletAddress = requireEnv('WALLET_ADDRESS');

  // Normalise: ensure 0x prefix
  const normPrivateKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  const normWallet = walletAddress.startsWith('0x') ? walletAddress : `0x${walletAddress}`;

  return {
    privateKey: normPrivateKey,
    walletAddress: normWallet,
    simmerApiKey: requireEnv('SIMMER_API_KEY'),
    simmerBaseUrl: optionalEnv('SIMMER_API_BASE', 'https://api.simmer.markets'),
    binanceWsUrl: optionalEnv('BINANCE_WS_URL', 'wss://stream.binance.com:9443/ws'),
    binanceSymbol: optionalEnv('BINANCE_SYMBOL', 'btcusdt'),
    analyticsFile: optionalEnv('ANALYTICS_FILE', './sniper-trades.jsonl'),
  };
}

export function loadConfig(): SniperConfig {
  const windows = (optionalEnv('MARKET_WINDOWS', '5m,15m').split(',') as MarketWindow[]);

  return {
    entryWindowSecs: parseInt(optionalEnv('ENTRY_WINDOW_SECS', '45'), 10),
    sustainedMoveSecs: parseInt(optionalEnv('SUSTAINED_MOVE_SECS', '10'), 10),
    exitBeforeExpirySecs: parseInt(optionalEnv('EXIT_BEFORE_EXPIRY_SECS', '5'), 10),

    minMovePct: parseFloat(optionalEnv('MIN_MOVE_PCT', '0.20')),
    yesMaxForBuyYes: parseFloat(optionalEnv('YES_MAX_FOR_BUY_YES', '0.72')),
    yesMinForBuyNo: parseFloat(optionalEnv('YES_MIN_FOR_BUY_NO', '0.30')),

    maxSpread: parseFloat(optionalEnv('MAX_SPREAD', '0.03')),
    minLiquidity: parseFloat(optionalEnv('MIN_LIQUIDITY', '50')),

    limitOrderTtlMs: parseInt(optionalEnv('LIMIT_ORDER_TTL_MS', '2000'), 10),
    aggressiveFillThreshold: optionalEnv('AGGRESSIVE_FILL_THRESHOLD', 'HIGH') as SignalStrength,

    maxOpenPositions: parseInt(optionalEnv('MAX_OPEN_POSITIONS', '1'), 10),
    dailyStopLossPct: parseFloat(optionalEnv('DAILY_STOP_LOSS_PCT', '0.10')),
    baseBetPct: parseFloat(optionalEnv('BASE_BET_PCT', '0.02')),
    maxBetPct: parseFloat(optionalEnv('MAX_BET_PCT', '0.05')),

    windows,
    asset: optionalEnv('ASSET', 'BTC'),
    pollIntervalMs: parseInt(optionalEnv('POLL_INTERVAL_MS', '2000'), 10),

    dryRun: optionalEnv('DRY_RUN', 'false') === 'true',
    logLevel: optionalEnv('LOG_LEVEL', 'info'),
  };
}
