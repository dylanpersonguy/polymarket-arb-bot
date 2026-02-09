/* Shared types for CLOB layer */

export interface OrderBookLevel {
  price: number;
  size: number;
}

export interface OrderBook {
  tokenId: string;
  bestBidPrice: number;
  bestBidSize: number;
  bestAskPrice: number;
  bestAskSize: number;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  lastUpdatedMs: number;
}

export interface Order {
  id: string;
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  filledSize: number;
  status: "open" | "filled" | "partial" | "cancelled" | "expired";
  createdAt: number;
  updatedAt: number;
}

export interface Fill {
  id: string;
  orderId: string;
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}

export interface Position {
  tokenId: string;
  size: number;
  avgPrice: number;
  avgCost?: number;
  unrealizedPnL: number;
  updatedAt?: number;
}
