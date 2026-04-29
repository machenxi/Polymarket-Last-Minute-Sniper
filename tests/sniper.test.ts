import { SniperStrategy } from '../src/strategies/sniper';
import { RiskManager } from '../src/risk/manager';
import type { SniperConfig, ParsedMarket, BtcPriceSnapshot } from '../src/types/index';

// Mock SimmerClient
jest.mock('../src/clients/simmer', () => ({
  SimmerClient: jest.fn().mockImplementation(() => ({
    importMarket: jest.fn().mockResolvedValue({ id: 'market-123' }),
    placeTrade: jest.fn().mockResolvedValue({
      id: 'trade-abc',
      status: 'FILLED',
      market_id: 'market-123',
      side: 'YES',
      amount: 20,
      price: 0.65,
    }),
    cancelOrder: jest.fn().mockResolvedValue(undefined),
  })),
}));

const mockConfig: SniperConfig = {
  entryWindowSecs: 45,
  sustainedMoveSecs: 10,
  exitBeforeExpirySecs: 5,
  minMovePct: 0.20,
  yesMaxForBuyYes: 0.72,
  yesMinForBuyNo: 0.30,
  maxSpread: 0.03,
  minLiquidity: 50,
  limitOrderTtlMs: 2000,
  aggressiveFillThreshold: 'HIGH',
  maxOpenPositions: 1,
  dailyStopLossPct: 0.10,
  baseBetPct: 0.02,
  maxBetPct: 0.05,
  windows: ['5m', '15m'],
  asset: 'BTC',
  pollIntervalMs: 2000,
  dryRun: true,
  logLevel: 'silent',
};

function makeMarket(overrides: Partial<ParsedMarket> = {}): ParsedMarket {
  const now = Date.now();
  return {
    id: 'market-123',
    question: 'Will BTC be up or down in 5m?',
    slug: 'will-btc-5m-test-123',
    window: '5m',
    endTime: new Date(now + 30_000), // 30 seconds from now
    remainingSecs: 30,
    yesPrice: 0.60,
    noPrice: 0.40,
    spread: 0.02,
    liquidity: 500,
    volume: 1000,
    yesTokenId: 'token-yes',
    noTokenId: 'token-no',
    ...overrides,
  };
}

function makePriceSnapshot(price: number): BtcPriceSnapshot {
  return { price, timestamp: Date.now() };
}

function makeRiskManager(): RiskManager {
  return new RiskManager(mockConfig, 1000);
}

function makeStrategy(rm?: RiskManager): SniperStrategy {
  const { SimmerClient } = require('../src/clients/simmer');
  const simmer = new SimmerClient('key', 'https://api.example.com');
  return new SniperStrategy(mockConfig, simmer, rm ?? makeRiskManager());
}

describe('SniperStrategy – evaluateSignal', () => {
  it('rejects when too early (remainingSecs > entryWindow)', () => {
    const strategy = makeStrategy();
    const market = makeMarket({
      endTime: new Date(Date.now() + 120_000), // 2 min from now
      remainingSecs: 120,
    });
    strategy.registerMarket(market);
    strategy.onBtcPrice(makePriceSnapshot(50_000));

    const result = strategy.evaluateSignal(market);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('TOO_EARLY');
  });

  it('rejects when spread is too wide', () => {
    const strategy = makeStrategy();
    const market = makeMarket({ spread: 0.05, remainingSecs: 30 });
    strategy.registerMarket(market);
    strategy.onBtcPrice(makePriceSnapshot(50_000));

    const result = strategy.evaluateSignal(market);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SPREAD_TOO_WIDE');
  });

  it('rejects when liquidity too low', () => {
    const strategy = makeStrategy();
    const market = makeMarket({ liquidity: 10, remainingSecs: 30 });
    strategy.registerMarket(market);
    strategy.onBtcPrice(makePriceSnapshot(50_000));

    const result = strategy.evaluateSignal(market);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('LOW_LIQUIDITY');
  });

  it('rejects when move is insufficient', () => {
    const strategy = makeStrategy();
    const market = makeMarket({ remainingSecs: 30 });

    // Open at 50000, current 50050 → move = 0.10% (< 0.20%)
    strategy.onBtcPrice(makePriceSnapshot(50_000));
    strategy.registerMarket(market);
    strategy.onBtcPrice(makePriceSnapshot(50_050));

    const result = strategy.evaluateSignal(market);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('INSUFFICIENT_MOVE');
  });

  it('rejects when move not yet sustained', () => {
    const strategy = makeStrategy();
    const market = makeMarket({ remainingSecs: 30 });

    // Open at 50000, current 50110 → +0.22% (above threshold)
    strategy.onBtcPrice(makePriceSnapshot(50_000));
    strategy.registerMarket(market);
    strategy.onBtcPrice(makePriceSnapshot(50_110));

    // sustainedSinceMs just set = 0ms elapsed → not sustained for 10s yet
    const result = strategy.evaluateSignal(market);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('MOVE_NOT_SUSTAINED');
  });

  it('rejects YES when yesPrice is too high (≥ yesMaxForBuyYes)', () => {
    const strategy = makeStrategy();
    const market = makeMarket({ yesPrice: 0.80, remainingSecs: 30 });

    strategy.onBtcPrice(makePriceSnapshot(50_000));
    strategy.registerMarket(market);

    // Simulate 11 seconds of positive move (open=50000, current=50150 → +0.30%)
    const priceState = (strategy as unknown as { priceStates: Map<string, unknown> }).priceStates.get('market-123') as { sustainedSinceMs: number | null };
    strategy.onBtcPrice(makePriceSnapshot(50_150));
    // Force sustained start in the past
    if (priceState) priceState.sustainedSinceMs = Date.now() - 11_000;

    const result = strategy.evaluateSignal(market);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PRICE_THRESHOLD_MISS');
  });

  it('generates a YES signal for BTC up move with valid conditions', () => {
    const strategy = makeStrategy();
    const market = makeMarket({
      yesPrice: 0.55,
      spread: 0.02,
      liquidity: 200,
      remainingSecs: 30,
      endTime: new Date(Date.now() + 30_000),
    });

    strategy.onBtcPrice(makePriceSnapshot(50_000));
    strategy.registerMarket(market);
    strategy.onBtcPrice(makePriceSnapshot(50_200)); // +0.40%

    // Force sustained
    const priceStates = (strategy as unknown as { priceStates: Map<string, { sustainedSinceMs: number | null }> }).priceStates;
    const ps = priceStates.get('market-123');
    if (ps) ps.sustainedSinceMs = Date.now() - 11_000;

    const result = strategy.evaluateSignal(market);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.side).toBe('YES');
      expect(result.signal.movePct).toBeGreaterThan(0.20);
    }
  });

  it('generates a NO signal for BTC down move with valid conditions', () => {
    const strategy = makeStrategy();
    const market = makeMarket({
      yesPrice: 0.55,
      spread: 0.02,
      liquidity: 200,
      remainingSecs: 30,
      endTime: new Date(Date.now() + 30_000),
    });

    strategy.onBtcPrice(makePriceSnapshot(50_000));
    strategy.registerMarket(market);
    strategy.onBtcPrice(makePriceSnapshot(49_800)); // -0.40%

    // Force sustained
    const priceStates = (strategy as unknown as { priceStates: Map<string, { sustainedSinceMs: number | null }> }).priceStates;
    const ps = priceStates.get('market-123');
    if (ps) ps.sustainedSinceMs = Date.now() - 11_000;

    const result = strategy.evaluateSignal(market);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.signal.side).toBe('NO');
      expect(result.signal.movePct).toBeLessThan(-0.20);
    }
  });
});

describe('SniperStrategy – price tracking', () => {
  it('registers open price on first market registration', () => {
    const strategy = makeStrategy();
    strategy.onBtcPrice(makePriceSnapshot(50_000));
    const market = makeMarket();
    strategy.registerMarket(market);

    const state = strategy.getPriceState('market-123');
    expect(state).toBeDefined();
    expect(state!.openPrice).toBe(50_000);
  });

  it('calculates move percent correctly', () => {
    const strategy = makeStrategy();
    strategy.onBtcPrice(makePriceSnapshot(50_000));
    strategy.registerMarket(makeMarket());
    strategy.onBtcPrice(makePriceSnapshot(50_100));

    const state = strategy.getPriceState('market-123');
    expect(state?.movePct).toBeCloseTo(0.20, 2);
  });

  it('resets sustained timer when move drops below threshold', () => {
    const strategy = makeStrategy();
    strategy.onBtcPrice(makePriceSnapshot(50_000));
    strategy.registerMarket(makeMarket());

    // Big move
    strategy.onBtcPrice(makePriceSnapshot(50_200));
    let state = strategy.getPriceState('market-123');
    expect(state?.sustainedSinceMs).not.toBeNull();

    // Drop back
    strategy.onBtcPrice(makePriceSnapshot(50_050)); // +0.10% < threshold
    state = strategy.getPriceState('market-123');
    expect(state?.sustainedSinceMs).toBeNull();
  });
});
