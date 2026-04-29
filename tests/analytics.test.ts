import { AnalyticsDashboard } from '../src/analytics/dashboard';
import type { TradeRecord, RiskState } from '../src/types/index';
import fs from 'fs';
import path from 'path';
import os from 'os';

function makeTrade(overrides: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: `trade-${Math.random().toString(36).slice(2)}`,
    marketId: 'market-123',
    slug: 'will-btc-5m-test',
    window: '5m',
    side: 'YES',
    entryPrice: 0.65,
    exitPrice: 1.0,
    amount: 20,
    pnl: 10.77,
    won: true,
    openedAt: Date.now() - 30_000,
    closedAt: Date.now(),
    holdMs: 30_000,
    signalStrength: 'HIGH',
    movePct: 0.35,
    minuteBucket: 4,
    ...overrides,
  };
}

const mockRiskState: RiskState = {
  bankroll: 1100,
  dailyPnl: 50,
  dailyTrades: 5,
  openPositions: 0,
  dailyStopHit: false,
  lastResetDate: new Date().toISOString().slice(0, 10),
};

describe('AnalyticsDashboard', () => {
  let tmpFile: string;
  let dashboard: AnalyticsDashboard;

  beforeEach(() => {
    tmpFile = path.join(os.tmpdir(), `sniper-test-${Date.now()}.jsonl`);
    dashboard = new AnalyticsDashboard(tmpFile);
  });

  afterEach(() => {
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  });

  describe('snapshot', () => {
    it('returns zero stats when no trades', () => {
      const snap = dashboard.snapshot(mockRiskState);
      expect(snap.totalTrades).toBe(0);
      expect(snap.winRate).toBe(0);
      expect(snap.totalPnl).toBe(0);
    });

    it('calculates win rate correctly', () => {
      dashboard.appendTrade(makeTrade({ won: true, pnl: 10 }));
      dashboard.appendTrade(makeTrade({ won: true, pnl: 10 }));
      dashboard.appendTrade(makeTrade({ won: false, pnl: -5 }));

      const snap = dashboard.snapshot(mockRiskState);
      expect(snap.totalTrades).toBe(3);
      expect(snap.wins).toBe(2);
      expect(snap.losses).toBe(1);
      expect(snap.winRate).toBeCloseTo(66.67, 1);
    });

    it('calculates total pnl correctly', () => {
      dashboard.appendTrade(makeTrade({ pnl: 10.5 }));
      dashboard.appendTrade(makeTrade({ pnl: -3.2 }));
      dashboard.appendTrade(makeTrade({ pnl: 7.1 }));

      const snap = dashboard.snapshot(mockRiskState);
      expect(snap.totalPnl).toBeCloseTo(14.4, 1);
    });

    it('calculates average hold time', () => {
      dashboard.appendTrade(makeTrade({ holdMs: 30_000 }));
      dashboard.appendTrade(makeTrade({ holdMs: 10_000 }));

      const snap = dashboard.snapshot(mockRiskState);
      expect(snap.avgHoldMs).toBe(20_000);
      expect(snap.avgHoldSec).toBe(20);
    });

    it('groups correctly by minute bucket', () => {
      dashboard.appendTrade(makeTrade({ minuteBucket: 3, pnl: 5, won: true }));
      dashboard.appendTrade(makeTrade({ minuteBucket: 3, pnl: -2, won: false }));
      dashboard.appendTrade(makeTrade({ minuteBucket: 4, pnl: 8, won: true }));

      const snap = dashboard.snapshot(mockRiskState);
      const bucket3 = snap.byMinuteBucket.find((b) => b.bucket === 3);
      const bucket4 = snap.byMinuteBucket.find((b) => b.bucket === 4);

      expect(bucket3).toBeDefined();
      expect(bucket3!.trades).toBe(2);
      expect(bucket3!.wins).toBe(1);
      expect(bucket3!.winRate).toBe(50);
      expect(bucket3!.totalPnl).toBeCloseTo(3, 5);

      expect(bucket4).toBeDefined();
      expect(bucket4!.trades).toBe(1);
      expect(bucket4!.winRate).toBe(100);
    });

    it('groups by signal strength', () => {
      dashboard.appendTrade(makeTrade({ signalStrength: 'HIGH', pnl: 10, won: true }));
      dashboard.appendTrade(makeTrade({ signalStrength: 'HIGH', pnl: -3, won: false }));
      dashboard.appendTrade(makeTrade({ signalStrength: 'MODERATE', pnl: 5, won: true }));

      const snap = dashboard.snapshot(mockRiskState);
      expect(snap.bySignalStrength.HIGH.trades).toBe(2);
      expect(snap.bySignalStrength.HIGH.wins).toBe(1);
      expect(snap.bySignalStrength.HIGH.pnl).toBeCloseTo(7, 5);
      expect(snap.bySignalStrength.MODERATE.trades).toBe(1);
    });

    it('includes last 10 trades in recentTrades', () => {
      for (let i = 0; i < 15; i++) {
        dashboard.appendTrade(makeTrade({ pnl: i }));
      }
      const snap = dashboard.snapshot(mockRiskState);
      expect(snap.recentTrades.length).toBe(10);
    });
  });

  describe('persistence', () => {
    it('writes trades to jsonl file', () => {
      dashboard.appendTrade(makeTrade({ pnl: 5 }));
      dashboard.appendTrade(makeTrade({ pnl: -2 }));

      const content = fs.readFileSync(tmpFile, 'utf8');
      const lines = content.trim().split('\n');
      expect(lines).toHaveLength(2);
      const parsed = JSON.parse(lines[0]) as TradeRecord;
      expect(parsed.pnl).toBe(5);
    });

    it('loads existing trades on construction', () => {
      // Write two trades manually
      const t1 = makeTrade({ pnl: 10, won: true });
      const t2 = makeTrade({ pnl: -5, won: false });
      fs.writeFileSync(tmpFile, JSON.stringify(t1) + '\n' + JSON.stringify(t2) + '\n');

      const db2 = new AnalyticsDashboard(tmpFile);
      const snap = db2.snapshot(mockRiskState);
      expect(snap.totalTrades).toBe(2);
      expect(snap.wins).toBe(1);
    });
  });
});
