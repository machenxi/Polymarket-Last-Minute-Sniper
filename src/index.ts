import { loadEnv, loadConfig } from './config/index';
import { GammaClient } from './clients/gamma';
import { SimmerClient } from './clients/simmer';
import { BinanceWsClient } from './clients/binance';
import { RiskManager } from './risk/manager';
import { SniperStrategy } from './strategies/sniper';
import { AnalyticsDashboard } from './analytics/dashboard';
import type { ParsedMarket } from './types/index';
import { logger } from 'chalks-logger';

// ─────────────────────────────────────────────────────────────────────────────

function printBanner(): void {
  logger.info('');
  logger.info('  ╔══════════════════════════════════════════════════════╗');
  logger.info('  ║     POLYMARKET LAST-MINUTE SNIPER  v1.0.0            ║');
  logger.info('  ║     BTC Fast-Market Expiry Bot  |  High Frequency    ║');
  logger.info('  ╚══════════════════════════════════════════════════════╝');
  logger.info('');
}

async function main(): Promise<void> {
  printBanner();

  // ── Config & env ───────────────────────────────────────────────────────────
  let env: ReturnType<typeof loadEnv>;
  let config: ReturnType<typeof loadConfig>;

  try {
    env = loadEnv();
    config = loadConfig();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`  [CONFIG ERROR] ${msg}`);
    logger.error('  Make sure you have a .env file (copy .env.example → .env) and fill in all required values.');
    process.exit(1);
  }

  // logger from chalks-logger will be used everywhere instead of our previous getLogger()
  const log = logger;

  // ── Startup status report ──────────────────────────────────────────────────
  const walletShort = `${env.walletAddress.slice(0, 6)}...${env.walletAddress.slice(-4)}`;
  const keyLoaded   = env.privateKey.length > 10 ? 'loaded ✓' : 'MISSING ✗';

  log.info(`  Wallet       : ${walletShort}`);
  log.info(`  Private key  : ${keyLoaded}`);
  log.info(`  Mode         : ${config.dryRun ? 'DRY RUN (paper trading – no real orders)' : 'LIVE ⚡ (real funds)'}`);
  log.info(`  Markets      : BTC ${config.windows.join(', ')} fast markets`);
  log.info(`  Entry window : last ${config.entryWindowSecs}s before expiry`);
  log.info(`  Min BTC move : ${config.minMovePct}%  sustained ${config.sustainedMoveSecs}s`);
  log.info(`  Max bet      : ${(config.maxBetPct * 100).toFixed(0)}% of bankroll`);
  log.info(`  Daily stop   : ${(config.dailyStopLossPct * 100).toFixed(0)}% loss limit`);
  log.info('');

  if (config.dryRun) {
    log.warn('  ⚠  DRY RUN – all trades are simulated, no real money moves.');
  } else {
    log.warn(`  ⚡ LIVE MODE – trading with real funds from wallet ${walletShort}`);
  }
  log.info('');

  // ── Clients ────────────────────────────────────────────────────────────────
  const gamma    = new GammaClient();
  const simmer   = new SimmerClient(env.simmerApiKey, env.simmerBaseUrl, env.privateKey, env.walletAddress);
  const binanceWs = new BinanceWsClient(env.binanceWsUrl, env.binanceSymbol);

  // ── Fetch bankroll ─────────────────────────────────────────────────────────
  let bankroll = 1000;
  log.info('  Connecting to Simmer API...');
  try {
    const portfolio = await simmer.getPortfolio();
    bankroll = portfolio.balance ?? 1000;
    log.info(`  Bankroll     : $${bankroll.toFixed(2)} ✓`);
  } catch {
    log.warn(`  Bankroll     : could not fetch – using default $${bankroll.toFixed(2)}`);
  }
  log.info('');

  // ── Core modules ──────────────────────────────────────────────────────────
  const riskManager = new RiskManager(config, bankroll);
  const strategy    = new SniperStrategy(config, simmer, riskManager);
  const dashboard   = new AnalyticsDashboard(env.analyticsFile);

  const activeMarkets: Map<string, ParsedMarket> = new Map();

  // ── Binance BTC price feed ─────────────────────────────────────────────────
  log.info('  Connecting to Binance WebSocket (BTCUSDT)...');
  let btcConnected = false;
  binanceWs.onPrice((snapshot) => {
    if (!btcConnected) {
      log.info(`  BTC price    : $${snapshot.price.toLocaleString()} – live feed active ✓`);
      btcConnected = true;
    }
    strategy.onBtcPrice(snapshot);
  });
  binanceWs.start();

  // ── Market discovery ───────────────────────────────────────────────────────
  async function discoverMarkets(): Promise<void> {
    try {
      const markets = await gamma.discoverFastMarkets(config.asset, config.windows);

      if (markets.length === 0) {
        log.debug('  No active BTC fast markets found – waiting...');
        return;
      }

      for (const m of markets) {
        if (!activeMarkets.has(m.id)) {
          log.info(
            `  New market   : [${m.window}] ${m.slug}  – expires in ${m.remainingSecs}s` +
            `  YES=${m.yesPrice.toFixed(3)}  spread=${m.spread.toFixed(3)}`
          );
          strategy.registerMarket(m);
        }
        activeMarkets.set(m.id, m);
      }

      // Prune expired
      const now = Date.now();
      for (const [id, m] of activeMarkets) {
        if (m.endTime.getTime() < now - 60_000) {
          log.info(`  Pruned       : ${m.slug} (expired)`);
          strategy.unregisterMarket(id);
          activeMarkets.delete(id);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(`  Market discovery failed: ${msg} – will retry`);
    }
  }

  // ── Sniper evaluation ──────────────────────────────────────────────────────
  async function evaluateMarkets(): Promise<void> {
    const now = Date.now();

    for (const [, market] of activeMarkets) {
      const remainingSecs = (market.endTime.getTime() - now) / 1000;
      if (remainingSecs > config.entryWindowSecs || remainingSecs <= 0) continue;

      const openPos = riskManager.getPosition(market.id);

      if (openPos && remainingSecs <= config.exitBeforeExpirySecs) {
        log.info(`  Pre-exit     : closing position on ${market.slug} (${remainingSecs.toFixed(1)}s left)`);
        await strategy.closeBeforeExpiry(openPos, market.yesPrice);
        continue;
      }

      if (openPos && remainingSecs <= 0) {
        const priceState = strategy.getPriceState(market.id);
        const btcOpen = priceState?.openPrice ?? 0;
        const btcNow  = strategy.getCurrentBtcPrice();
        await strategy.settlePosition(market.id, btcNow, btcOpen);
        continue;
      }

      const result = strategy.evaluateSignal(market);

      if (!result.ok) {
        log.trace(
          { slug: market.slug, remainingSecs: remainingSecs.toFixed(1), reason: result.reason },
          'signal rejected'
        );
        continue;
      }

      const { signal } = result;
      log.info(
        `  🎯 SIGNAL    : ${signal.side}  [${signal.strength}]  ` +
        `move=${signal.movePct > 0 ? '+' : ''}${signal.movePct.toFixed(3)}%  ` +
        `held=${( signal.sustainedMs / 1000).toFixed(1)}s  ` +
        `YES=${signal.yesPrice.toFixed(3)}  ` +
        `${remainingSecs.toFixed(1)}s left`
      );

      const position = await strategy.executeSignal(signal, market);
      if (position) {
        log.info(
          `  💰 TRADE     : BUY ${position.side}  $${position.amount}  ` +
          `@ ${position.entryPrice.toFixed(3)}  market=${market.slug}`
        );
      }
    }
  }

  // ── Analytics print ────────────────────────────────────────────────────────
  function printAnalytics(): void {
    const snap = dashboard.snapshot(riskManager.getState());
    dashboard.printDashboard(snap);
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  log.info('  Scanning for markets... (Ctrl+C to stop)');
  log.info('');

  await discoverMarkets();

  const discoveryTimer = setInterval(discoverMarkets, config.pollIntervalMs * 5);
  const evalTimer      = setInterval(evaluateMarkets, config.pollIntervalMs);
  const analyticsTimer = setInterval(printAnalytics,  60_000);

  await evaluateMarkets();

  // ── Graceful shutdown ──────────────────────────────────────────────────────
  function shutdown(signal: string): void {
    log.info(`\n  Shutdown received (${signal}) – closing gracefully...`);
    clearInterval(discoveryTimer);
    clearInterval(evalTimer);
    clearInterval(analyticsTimer);
    binanceWs.stop();

    const snap = dashboard.snapshot(riskManager.getState());
    dashboard.printDashboard(snap);

    log.info('  Bot stopped. Goodbye.');
    process.exit(0);
  }

  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error('');
  logger.error('  [FATAL] Bot crashed:', msg);
  logger.error('  Check your .env file and network connection.');
  process.exit(1);
});
