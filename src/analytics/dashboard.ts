import fs from 'fs';
import path from 'path';
import type {
  TradeRecord,
  DashboardSnapshot,
  MinuteBucketStats,
  SignalStrength,
  RiskState,
} from '../types/index';
import { getLogger } from '../utils/logger';

export class AnalyticsDashboard {
  private readonly log = getLogger().child({ module: 'Analytics' });
  private trades: TradeRecord[] = [];
  private readonly filePath: string;

  constructor(analyticsFile: string) {
    this.filePath = path.resolve(analyticsFile);
    this.loadExisting();
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  private loadExisting(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        const lines = fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean);
        this.trades = lines.map((l) => JSON.parse(l) as TradeRecord);
        this.log.info({ count: this.trades.length, file: this.filePath }, 'loaded existing trades');
      }
    } catch (err) {
      this.log.warn({ err }, 'could not load existing analytics file');
    }
  }

  appendTrade(trade: TradeRecord): void {
    this.trades.push(trade);
    try {
      fs.appendFileSync(this.filePath, JSON.stringify(trade) + '\n');
    } catch (err) {
      this.log.error({ err }, 'failed to write trade to file');
    }
  }

  // ── Snapshot generation ───────────────────────────────────────────────────

  snapshot(riskState: RiskState): DashboardSnapshot {
    const closed = this.trades.filter((t) => t.pnl !== undefined);
    const wins = closed.filter((t) => t.won === true);
    const losses = closed.filter((t) => t.won === false);

    const totalPnl = closed.reduce((s, t) => s + (t.pnl ?? 0), 0);
    const avgHoldMs =
      closed.length > 0
        ? closed.reduce((s, t) => s + (t.holdMs ?? 0), 0) / closed.length
        : 0;

    const initialBankroll = riskState.bankroll - totalPnl;
    const roi = initialBankroll > 0 ? (totalPnl / initialBankroll) * 100 : 0;

    return {
      asOf: new Date().toISOString(),
      totalTrades: closed.length,
      wins: wins.length,
      losses: losses.length,
      winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : 0,
      totalPnl,
      roi,
      avgHoldMs,
      avgHoldSec: avgHoldMs / 1000,
      bankroll: riskState.bankroll,
      dailyPnl: riskState.dailyPnl,
      byMinuteBucket: this.byMinuteBucket(closed),
      bySignalStrength: this.bySignalStrength(closed),
      recentTrades: closed.slice(-10).reverse(),
    };
  }

  private byMinuteBucket(trades: TradeRecord[]): MinuteBucketStats[] {
    const buckets: Map<number, TradeRecord[]> = new Map();
    for (const t of trades) {
      const b = t.minuteBucket;
      if (!buckets.has(b)) buckets.set(b, []);
      buckets.get(b)!.push(t);
    }

    const result: MinuteBucketStats[] = [];
    for (const [bucket, ts] of Array.from(buckets.entries()).sort(([a], [b]) => a - b)) {
      const wins = ts.filter((t) => t.won).length;
      const totalPnl = ts.reduce((s, t) => s + (t.pnl ?? 0), 0);
      result.push({
        bucket,
        trades: ts.length,
        wins,
        losses: ts.length - wins,
        winRate: ts.length > 0 ? (wins / ts.length) * 100 : 0,
        totalPnl,
        avgPnl: ts.length > 0 ? totalPnl / ts.length : 0,
      });
    }
    return result;
  }

  private bySignalStrength(
    trades: TradeRecord[]
  ): Record<SignalStrength, { trades: number; wins: number; pnl: number }> {
    const result: Record<SignalStrength, { trades: number; wins: number; pnl: number }> = {
      HIGH: { trades: 0, wins: 0, pnl: 0 },
      MODERATE: { trades: 0, wins: 0, pnl: 0 },
      WEAK: { trades: 0, wins: 0, pnl: 0 },
    };

    for (const t of trades) {
      const s = t.signalStrength;
      result[s].trades++;
      if (t.won) result[s].wins++;
      result[s].pnl += t.pnl ?? 0;
    }

    return result;
  }

  // ── Console render ────────────────────────────────────────────────────────

  printDashboard(snap: DashboardSnapshot): void {
    const line = '─'.repeat(60);
    console.log(`\n${line}`);
    console.log('  📊  POLYMARKET LAST-MINUTE SNIPER  –  ANALYTICS');
    console.log(`${line}`);
    console.log(`  As of          : ${snap.asOf}`);
    console.log(`  Bankroll       : $${snap.bankroll.toFixed(2)}`);
    console.log(`  Daily P&L      : $${snap.dailyPnl.toFixed(4)}`);
    console.log(`  Total P&L      : $${snap.totalPnl.toFixed(4)}`);
    console.log(`  ROI            : ${snap.roi.toFixed(2)}%`);
    console.log(`  Total Trades   : ${snap.totalTrades}`);
    console.log(`  Win Rate       : ${snap.winRate.toFixed(1)}%  (${snap.wins}W / ${snap.losses}L)`);
    console.log(`  Avg Hold Time  : ${snap.avgHoldSec.toFixed(1)}s`);

    if (snap.byMinuteBucket.length > 0) {
      console.log(`\n  P&L by Minute Bucket:`);
      for (const b of snap.byMinuteBucket) {
        const bar = '█'.repeat(Math.max(0, Math.floor(b.winRate / 10)));
        console.log(
          `    min ${b.bucket.toString().padStart(2)}  ${bar.padEnd(10)}  ` +
          `${b.winRate.toFixed(0).padStart(3)}% WR  ${b.trades} trades  pnl $${b.totalPnl.toFixed(4)}`
        );
      }
    }

    if (snap.recentTrades.length > 0) {
      console.log(`\n  Recent Trades (last ${snap.recentTrades.length}):`);
      for (const t of snap.recentTrades) {
        const ts = new Date(t.openedAt).toISOString().slice(11, 19);
        const outcome = t.won ? '✓' : '✗';
        console.log(
          `    ${outcome} ${ts}  ${t.side.padEnd(3)}  ` +
          `entry ${t.entryPrice.toFixed(3)}  ` +
          `pnl $${(t.pnl ?? 0).toFixed(4)}  [${t.signalStrength}]`
        );
      }
    }

    console.log(`  Signal Strength Breakdown:`);
    for (const [s, stat] of Object.entries(snap.bySignalStrength)) {
      if (stat.trades > 0) {
        const wr = ((stat.wins / stat.trades) * 100).toFixed(0);
        console.log(`    ${s.padEnd(8)}  ${stat.trades} trades  ${wr}% WR  pnl $${stat.pnl.toFixed(4)}`);
      }
    }

    console.log(`${line}\n`);
  }
}
