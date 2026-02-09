export interface OrderBook {
  tokenId: string;
  bestBidPrice: number;
  bestBidSize: number;
  bestAskPrice: number;
  bestAskSize: number;
  lastUpdatedMs: number;
}

export interface Order {
  id: string;
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  filledSize: number;
  status: "open" | "filled" | "cancelled" | "expired";
  createdAt: number;
  updatedAt: number;
}

export interface Position {
  tokenId: string;
  size: number;
  avgPrice: number;
  unrealizedPnL: number;
  updatedAt: number;
}

export interface Trade {
  id: string;
  orderId: string;
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  fee: number;
  timestamp: number;
}
