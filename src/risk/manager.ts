import type {
  RiskState,
  ActivePosition,
  PositionSizeResult,
  SniperConfig,
  TradeSide,
  SignalStrength,
} from '../types/index';
import { getLogger } from '../utils/logger';

export class RiskManager {
  private readonly log = getLogger().child({ module: 'RiskManager' });
  private state: RiskState;
  private readonly openPositions: Map<string, ActivePosition> = new Map();

  constructor(
    private readonly config: SniperConfig,
    initialBankroll: number
  ) {
    this.state = {
      bankroll: initialBankroll,
      dailyPnl: 0,
      dailyTrades: 0,
      openPositions: 0,
      dailyStopHit: false,
      lastResetDate: this.todayStr(),
    };
  }

  // ── Daily reset ───────────────────────────────────────────────────────────

  tick(): void {
    const today = this.todayStr();
    if (today !== this.state.lastResetDate) {
      this.log.info({ date: today }, 'new trading day – resetting daily counters');
      this.state.dailyPnl = 0;
      this.state.dailyTrades = 0;
      this.state.dailyStopHit = false;
      this.state.lastResetDate = today;
    }
  }

  // ── Gate checks ──────────────────────────────────────────────────────────

  canTrade(marketId: string): { ok: boolean; reason?: string } {
    this.tick();

    if (this.state.dailyStopHit) {
      return { ok: false, reason: 'DAILY_LOSS_LIMIT' };
    }

    // Duplicate check before max-positions check (more specific error first)
    if (this.openPositions.has(marketId)) {
      return { ok: false, reason: 'DUPLICATE_POSITION' };
    }

    if (this.state.openPositions >= this.config.maxOpenPositions) {
      return { ok: false, reason: 'MAX_POSITIONS_REACHED' };
    }

    const dailyStopAmount = this.state.bankroll * this.config.dailyStopLossPct;
    if (this.state.dailyPnl <= -dailyStopAmount) {
      this.state.dailyStopHit = true;
      this.log.warn(
        { dailyPnl: this.state.dailyPnl, limit: -dailyStopAmount },
        'daily stop loss hit'
      );
      return { ok: false, reason: 'DAILY_LOSS_LIMIT' };
    }

    return { ok: true };
  }

  // ── Position sizing ───────────────────────────────────────────────────────

  sizePosition(strength: SignalStrength): PositionSizeResult {
    const base = this.state.bankroll * this.config.baseBetPct;
    const max = this.state.bankroll * this.config.maxBetPct;

    let multiplier: number;
    let reason: string;

    switch (strength) {
      case 'HIGH':
        multiplier = 1.0;
        reason = 'HIGH confidence – max size';
        break;
      case 'MODERATE':
        multiplier = 0.6;
        reason = 'MODERATE confidence – standard size';
        break;
      default:
        multiplier = 0.3;
        reason = 'WEAK confidence – minimal size';
    }

    const raw = base + (max - base) * multiplier;
    const amount = Math.min(Math.max(raw, 1), max);
    const pct = amount / this.state.bankroll;

    return { amount: parseFloat(amount.toFixed(2)), pct, reason };
  }

  // ── Position lifecycle ────────────────────────────────────────────────────

  openPosition(position: ActivePosition): void {
    this.openPositions.set(position.marketId, position);
    this.state.openPositions = this.openPositions.size;
    this.state.dailyTrades++;
    this.log.info(
      { marketId: position.marketId, side: position.side, amount: position.amount },
      'position opened'
    );
  }

  closePosition(marketId: string, exitPrice: number): ActivePosition | null {
    const pos = this.openPositions.get(marketId);
    if (!pos) return null;

    const pnl = this.calculatePnl(pos, exitPrice);
    pos.pnl = pnl;
    pos.currentPrice = exitPrice;
    pos.closedAt = Date.now();
    pos.status = 'CLOSED';

    this.openPositions.delete(marketId);
    this.state.openPositions = this.openPositions.size;
    this.state.bankroll += pnl;
    this.state.dailyPnl += pnl;

    this.log.info(
      { marketId, side: pos.side, pnl: pnl.toFixed(4), bankroll: this.state.bankroll.toFixed(2) },
      'position closed'
    );

    return pos;
  }

  expirePosition(marketId: string, won: boolean): ActivePosition | null {
    const pos = this.openPositions.get(marketId);
    if (!pos) return null;

    // If YES side wins: get ~$1/share if entry was at yesPrice
    // Simplified: won means full payout (1.0), lost means 0
    const settlementPrice = won ? 1.0 : 0.0;
    const pnl = this.calculatePnl(pos, settlementPrice);

    pos.pnl = pnl;
    pos.currentPrice = settlementPrice;
    pos.closedAt = Date.now();
    pos.status = 'EXPIRED';

    this.openPositions.delete(marketId);
    this.state.openPositions = this.openPositions.size;
    this.state.bankroll += pnl;
    this.state.dailyPnl += pnl;

    this.log.info(
      { marketId, won, pnl: pnl.toFixed(4) },
      'position expired/settled'
    );

    return pos;
  }

  private calculatePnl(pos: ActivePosition, exitPrice: number): number {
    // shares = amount / entryPrice
    // pnl = shares * (exitPrice - entryPrice)
    const shares = pos.amount / pos.entryPrice;
    return shares * (exitPrice - pos.entryPrice);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  getState(): Readonly<RiskState> {
    return { ...this.state };
  }

  getOpenPositions(): ActivePosition[] {
    return Array.from(this.openPositions.values());
  }

  getPosition(marketId: string): ActivePosition | undefined {
    return this.openPositions.get(marketId);
  }

  updateBankroll(newBankroll: number): void {
    this.log.debug({ old: this.state.bankroll, new: newBankroll }, 'bankroll updated');
    this.state.bankroll = newBankroll;
  }

  isOpenForMarket(marketId: string): boolean {
    return this.openPositions.has(marketId);
  }

  // ── Signal strength classifier ────────────────────────────────────────────

  classifySignalStrength(
    movePct: number,
    sustainedMs: number,
    side: TradeSide,
    yesPrice: number,
    minMovePct: number
  ): SignalStrength {
    const sustainedSecs = sustainedMs / 1000;
    const absMove = Math.abs(movePct);

    // Edge alignment: YES should be cheap when buying YES (confirms mispricing)
    const priceEdge =
      side === 'YES'
        ? yesPrice < 0.55   // strong edge if YES is under 0.55
        : yesPrice > 0.50;  // strong edge if YES is over 0.50 (NO is cheap)

    if (absMove >= minMovePct * 2 && sustainedSecs >= 20 && priceEdge) {
      return 'HIGH';
    }
    if (absMove >= minMovePct * 1.4 && sustainedSecs >= 12) {
      return 'MODERATE';
    }
    return 'WEAK';
  }

  private todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }
}
