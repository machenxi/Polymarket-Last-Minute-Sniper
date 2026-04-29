import axios from 'axios';
import type { GammaMarket, ParsedMarket, MarketWindow } from '../types/index';
import { getLogger } from '../utils/logger';

const GAMMA_BASE = 'https://gamma-api.polymarket.com';

// Slug segment patterns for fast markets, e.g. "will-btc-5m-...", "-15m-"
const WINDOW_SLUG_MAP: Record<MarketWindow, string> = {
  '5m': '-5m-',
  '15m': '-15m-',
};

const ASSET_PATTERNS: Record<string, RegExp> = {
  BTC: /bitcoin|btc/i,
};

export class GammaClient {
  private readonly log = getLogger().child({ module: 'GammaClient' });

  async fetchMarkets(limit = 30): Promise<GammaMarket[]> {
    const url = `${GAMMA_BASE}/markets`;
    const { data } = await axios.get<GammaMarket[]>(url, {
      params: {
        limit,
        closed: false,
        tag: 'crypto',
        order: 'createdAt',
        ascending: false,
      },
      timeout: 8_000,
    });
    return Array.isArray(data) ? data : [];
  }

  async discoverFastMarkets(asset: string, windows: MarketWindow[]): Promise<ParsedMarket[]> {
    const raw = await this.fetchMarkets(50);
    const assetPattern = ASSET_PATTERNS[asset.toUpperCase()];
    if (!assetPattern) throw new Error(`Unknown asset: ${asset}`);

    const results: ParsedMarket[] = [];

    for (const market of raw) {
      if (market.closed) continue;
      if (!market.slug) continue;
      if (!assetPattern.test(market.question)) continue;

      for (const window of windows) {
        const slugFragment = WINDOW_SLUG_MAP[window];
        if (!market.slug.includes(slugFragment)) continue;

        const parsed = this.parseMarket(market, window);
        if (parsed) results.push(parsed);
      }
    }

    this.log.debug({ count: results.length }, 'discovered fast markets');
    return results;
  }

  parseMarket(raw: GammaMarket, window: MarketWindow): ParsedMarket | null {
    try {
      const endTime = this.extractEndTime(raw);
      if (!endTime) return null;

      const now = Date.now();
      const remainingSecs = Math.floor((endTime.getTime() - now) / 1000);
      if (remainingSecs <= 0) return null;

      const prices = this.parsePrices(raw);
      if (!prices) return null;

      const tokenIds = this.parseTokenIds(raw);

      const spread = Math.abs(prices.yesPrice - (1 - prices.noPrice));

      return {
        id: raw.id,
        question: raw.question,
        slug: raw.slug,
        window,
        endTime,
        remainingSecs,
        yesPrice: prices.yesPrice,
        noPrice: prices.noPrice,
        spread,
        liquidity: raw.liquidity ?? 0,
        volume: raw.volume ?? 0,
        yesTokenId: tokenIds[0] ?? '',
        noTokenId: tokenIds[1] ?? '',
      };
    } catch (err) {
      this.log.warn({ slug: raw.slug, err }, 'failed to parse market');
      return null;
    }
  }

  private extractEndTime(market: GammaMarket): Date | null {
    // Primary: ISO date in endDate field
    if (market.endDate) {
      const d = new Date(market.endDate);
      if (!isNaN(d.getTime())) return d;
    }

    // Fallback: parse from question text e.g. "...by 14:35 UTC?"
    const timeMatch = market.question.match(/(\d{1,2}):(\d{2})\s*UTC/i);
    if (timeMatch) {
      const now = new Date();
      const candidate = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
          parseInt(timeMatch[1], 10), parseInt(timeMatch[2], 10), 0)
      );
      if (candidate.getTime() > Date.now() - 60_000) return candidate;
    }

    return null;
  }

  private parsePrices(raw: GammaMarket): { yesPrice: number; noPrice: number } | null {
    try {
      if (raw.outcomePrices) {
        const arr = JSON.parse(raw.outcomePrices) as number[];
        if (arr.length >= 2) {
          return { yesPrice: arr[0], noPrice: arr[1] };
        }
      }
      // Fallback to bid/ask mid
      if (raw.bestBid !== undefined && raw.bestAsk !== undefined) {
        const mid = (raw.bestBid + raw.bestAsk) / 2;
        return { yesPrice: mid, noPrice: 1 - mid };
      }
      return null;
    } catch {
      return null;
    }
  }

  private parseTokenIds(raw: GammaMarket): string[] {
    if (raw.tokenIds && raw.tokenIds.length >= 2) return raw.tokenIds;
    return ['', ''];
  }
}
