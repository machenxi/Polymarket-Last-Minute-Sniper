import axios, { type AxiosInstance } from 'axios';
import type {
  SimmerTradeRequest,
  SimmerTradeResponse,
  SimmerMarket,
  SimmerPortfolio,
  SimmerPosition,
} from '../types/index';
import { getLogger } from '../utils/logger';

export class SimmerClient {
  private readonly http: AxiosInstance;
  private readonly log = getLogger().child({ module: 'SimmerClient' });
  /** Private key stored for future direct CLOB signing (currently routed via Simmer) */
  readonly privateKey: string | undefined;

  constructor(
    apiKey: string,
    baseUrl: string,
    privateKey?: string,
    private readonly walletAddress?: string
  ) {
    this.privateKey = privateKey;
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 10_000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        ...(walletAddress ? { 'X-Wallet-Address': walletAddress } : {}),
      },
    });

    this.http.interceptors.response.use(
      (r) => r,
      (err) => {
        const status = err.response?.status ?? 'network';
        const msg = err.response?.data?.message ?? err.message;
        this.log.error({ status, msg }, 'Simmer API error');
        return Promise.reject(err);
      }
    );
  }

  async importMarket(slug: string): Promise<SimmerMarket> {
    const url = `https://polymarket.com/event/${slug}`;
    this.log.info({ slug }, 'importing market');
    const { data } = await this.http.post<SimmerMarket>('/api/sdk/markets/import', {
      polymarket_url: url,
    });
    return data;
  }

  async getMarket(marketId: string): Promise<SimmerMarket> {
    const { data } = await this.http.get<SimmerMarket>(`/api/sdk/markets/${marketId}`);
    return data;
  }

  async placeTrade(
    marketId: string,
    side: 'YES' | 'NO',
    amount: number,
    dryRun: boolean
  ): Promise<SimmerTradeResponse> {
    const req: SimmerTradeRequest = {
      market_id: marketId,
      side,
      amount,
      venue: 'polymarket',
      source: 'sdk:sniper',
      ...(this.walletAddress ? { wallet_address: this.walletAddress } : {}),
    };

    if (dryRun) {
      this.log.info({ req }, '[DRY RUN] would place trade');
      return {
        id: `dry-${Date.now()}`,
        status: 'SIMULATED',
        market_id: marketId,
        side,
        amount,
        price: side === 'YES' ? 0.65 : 0.35,
      };
    }

    this.log.info({ marketId, side, amount }, 'placing trade');
    const { data } = await this.http.post<SimmerTradeResponse>('/api/sdk/trade', req);
    return data;
  }

  async getPortfolio(): Promise<SimmerPortfolio> {
    const { data } = await this.http.get<SimmerPortfolio>('/api/sdk/portfolio');
    return data;
  }

  async getPositions(): Promise<SimmerPosition[]> {
    const { data } = await this.http.get<{ positions: SimmerPosition[] }>('/api/sdk/positions');
    return data.positions ?? [];
  }

  async cancelOrder(orderId: string): Promise<void> {
    try {
      await this.http.delete(`/api/sdk/orders/${orderId}`);
      this.log.info({ orderId }, 'order cancelled');
    } catch (err) {
      this.log.warn({ orderId, err }, 'cancel order failed (may already be filled)');
    }
  }
}
