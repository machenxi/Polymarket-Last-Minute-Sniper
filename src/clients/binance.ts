import WebSocket from 'ws';
import type { BtcPriceSnapshot } from '../types/index';
import { getLogger } from '../utils/logger';

export type PriceHandler = (snapshot: BtcPriceSnapshot) => void;

interface BinanceTradeMessage {
  e: string;    // event type: 'trade'
  E: number;    // event time
  s: string;    // symbol
  p: string;    // price
  q: string;    // quantity
  T: number;    // trade time
}

export class BinanceWsClient {
  private ws: WebSocket | null = null;
  private readonly handlers: Set<PriceHandler> = new Set();
  private readonly log = getLogger().child({ module: 'BinanceWs' });
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private isShuttingDown = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly symbol: string
  ) {}

  start(): void {
    this.isShuttingDown = false;
    this.connect();
  }

  stop(): void {
    this.isShuttingDown = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
    }
    this.log.info('Binance WS stopped');
  }

  onPrice(handler: PriceHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  private connect(): void {
    const streamUrl = `${this.wsUrl}/${this.symbol}@trade`;
    this.log.info({ streamUrl }, 'connecting to Binance WebSocket');

    this.ws = new WebSocket(streamUrl);

    this.ws.on('open', () => {
      this.log.info('Binance WS connected');
      this.startPing();
    });

    this.ws.on('message', (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(raw.toString()) as BinanceTradeMessage;
        if (msg.e !== 'trade') return;

        const price = parseFloat(msg.p);
        if (isNaN(price) || price <= 0) return;

        const snapshot: BtcPriceSnapshot = { price, timestamp: msg.T };
        for (const h of this.handlers) h(snapshot);
      } catch {
        // malformed message – ignore
      }
    });

    this.ws.on('error', (err) => {
      this.log.error({ err: err.message }, 'Binance WS error');
    });

    this.ws.on('close', (code, reason) => {
      this.log.warn({ code, reason: reason.toString() }, 'Binance WS closed');
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (!this.isShuttingDown) {
        this.scheduleReconnect();
      }
    });
  }

  private startPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.ping();
      }
    }, 20_000);
  }

  private scheduleReconnect(delayMs = 3_000): void {
    this.reconnectTimer = setTimeout(() => {
      this.log.info('reconnecting to Binance WS...');
      this.connect();
    }, delayMs);
  }
}
