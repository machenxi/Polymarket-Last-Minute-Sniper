import { RiskManager } from '../src/risk/manager';
import type { SniperConfig, ActivePosition } from '../src/types/index';

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

function makePosition(overrides: Partial<ActivePosition> = {}): ActivePosition {
  return {
    id: 'test-pos-1',
    marketId: 'market-123',
    slug: 'will-btc-5m-test',
    side: 'YES',
    amount: 20,
    entryPrice: 0.65,
    currentPrice: 0.65,
    openedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    status: 'OPEN',
    orderId: 'order-abc',
    ...overrides,
  };
}

describe('RiskManager', () => {
  describe('canTrade', () => {
    it('allows trading when conditions are met', () => {
      const rm = new RiskManager(mockConfig, 1000);
      const result = rm.canTrade('market-new');
      expect(result.ok).toBe(true);
    });

    it('blocks when max open positions reached', () => {
      const rm = new RiskManager(mockConfig, 1000);
      rm.openPosition(makePosition({ marketId: 'market-A' }));
      const result = rm.canTrade('market-B');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('MAX_POSITIONS_REACHED');
    });

    it('blocks duplicate positions on same market', () => {
      const rm = new RiskManager(mockConfig, 1000);
      rm.openPosition(makePosition({ marketId: 'market-X' }));
      const result = rm.canTrade('market-X');
      expect(result.ok).toBe(false);
      expect(result.reason).toBe('DUPLICATE_POSITION');
    });

    it('blocks when daily stop loss is hit', () => {
      const rm = new RiskManager({ ...mockConfig, dailyStopLossPct: 0.05 }, 1000);
      // Simulate large loss via close
      rm.openPosition(makePosition({ marketId: 'loss-market', amount: 100, entryPrice: 0.90 }));
      rm.closePosition('loss-market', 0.0); // full loss
      const result = rm.canTrade('new-market');
      // Daily stop is $50 (5% of $1000)
      // Shares = 100/0.9 ≈ 111.1; pnl ≈ -100 (much more than $50 stop)
      expect(result.ok).toBe(false);
    });
  });

  describe('sizePosition', () => {
    it('sizes HIGH signal at max bet', () => {
      const rm = new RiskManager(mockConfig, 1000);
      const result = rm.sizePosition('HIGH');
      expect(result.amount).toBeCloseTo(50, 0); // 5% of 1000
    });

    it('sizes MODERATE signal between base and max', () => {
      const rm = new RiskManager(mockConfig, 1000);
      const result = rm.sizePosition('MODERATE');
      expect(result.amount).toBeGreaterThan(20);  // > base 2%
      expect(result.amount).toBeLessThan(50);     // < max 5%
    });

    it('sizes WEAK signal near base bet', () => {
      const rm = new RiskManager(mockConfig, 1000);
      const result = rm.sizePosition('WEAK');
      expect(result.amount).toBeGreaterThanOrEqual(1);
      expect(result.amount).toBeLessThanOrEqual(30);
    });
  });

  describe('openPosition / closePosition', () => {
    it('tracks open position and updates state', () => {
      const rm = new RiskManager(mockConfig, 1000);
      rm.openPosition(makePosition());
      const state = rm.getState();
      expect(state.openPositions).toBe(1);
      expect(state.dailyTrades).toBe(1);
    });

    it('calculates pnl correctly on close', () => {
      const rm = new RiskManager(mockConfig, 1000);
      // Buy $20 worth of YES at 0.50 → 40 shares
      const pos = makePosition({ amount: 20, entryPrice: 0.50 });
      rm.openPosition(pos);
      // Exit at 0.70 → pnl = 40 * (0.70 - 0.50) = $8
      const closed = rm.closePosition('market-123', 0.70);
      expect(closed).not.toBeNull();
      expect(closed!.pnl).toBeCloseTo(8, 1);
    });

    it('bankroll increases after profitable close', () => {
      const rm = new RiskManager(mockConfig, 1000);
      rm.openPosition(makePosition({ amount: 20, entryPrice: 0.50 }));
      rm.closePosition('market-123', 0.70);
      expect(rm.getState().bankroll).toBeGreaterThan(1000);
    });
  });

  describe('expirePosition', () => {
    it('settles as win correctly', () => {
      const rm = new RiskManager(mockConfig, 1000);
      rm.openPosition(makePosition({ amount: 20, entryPrice: 0.65 }));
      const closed = rm.expirePosition('market-123', true);
      expect(closed).not.toBeNull();
      // pnl = shares * (1.0 - 0.65) = 30.77 * 0.35 ≈ $10.77
      expect(closed!.pnl).toBeGreaterThan(0);
    });

    it('settles as loss correctly', () => {
      const rm = new RiskManager(mockConfig, 1000);
      rm.openPosition(makePosition({ amount: 20, entryPrice: 0.65 }));
      const closed = rm.expirePosition('market-123', false);
      expect(closed).not.toBeNull();
      expect(closed!.pnl).toBeLessThan(0);
    });
  });

  describe('classifySignalStrength', () => {
    it('classifies strong long-sustained move as HIGH', () => {
      const rm = new RiskManager(mockConfig, 1000);
      const str = rm.classifySignalStrength(0.50, 25_000, 'YES', 0.45, 0.20);
      expect(str).toBe('HIGH');
    });

    it('classifies moderate move as MODERATE', () => {
      const rm = new RiskManager(mockConfig, 1000);
      const str = rm.classifySignalStrength(0.30, 15_000, 'YES', 0.60, 0.20);
      expect(str).toBe('MODERATE');
    });

    it('classifies borderline move as WEAK', () => {
      const rm = new RiskManager(mockConfig, 1000);
      const str = rm.classifySignalStrength(0.21, 10_000, 'YES', 0.65, 0.20);
      expect(str).toBe('WEAK');
    });
  });
});
