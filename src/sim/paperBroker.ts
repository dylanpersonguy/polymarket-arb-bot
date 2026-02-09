import pino from "pino";
import { Order } from "../clob/types.js";

const logger = pino({ name: "PaperBroker" });

export interface PaperOrderRequest {
  tokenId: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  bestAsk: number;
  bestBid: number;
  fillProbability: number;
  extraSlippageBps: number;
}

export interface PaperFill {
  orderId: string;
  filled: boolean;
  filledSize: number;
  actualPrice: number;
  slippage: number;
}

export class PaperBroker {
  private orders = new Map<string, Order>();

  simulateFill(req: PaperOrderRequest): PaperFill {
    const orderId = `paper_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    // Determine if order fills
    const willFill = Math.random() < req.fillProbability;

    if (!willFill) {
      logger.debug({ orderId, side: req.side, price: req.price }, "Paper order not filled");
      return {
        orderId,
        filled: false,
        filledSize: 0,
        actualPrice: req.price,
        slippage: 0,
      };
    }

    // Calculate actual fill price with slippage
    const slippageBps = req.extraSlippageBps + (Math.random() * 5); // Random slippage up to 5bps extra
    const slippageAmount = req.price * (slippageBps / 10000);

    let actualPrice: number;
    if (req.side === "buy") {
      // For buys, we expect to pay more due to slippage
      actualPrice = Math.min(req.price + slippageAmount, req.bestAsk * 1.01);
    } else {
      // For sells, we expect to receive less due to slippage
      actualPrice = Math.max(req.price - slippageAmount, req.bestBid * 0.99);
    }

    // Partial fills are possible (50% chance of 100% fill, 50% chance of 50-100% fill)
    const filledSize = Math.random() < 0.5 ? req.size : req.size * (0.5 + Math.random() * 0.5);

    logger.debug(
      { orderId, side: req.side, filledSize, actualPrice, slippageBps },
      "Paper order filled"
    );

    return {
      orderId,
      filled: true,
      filledSize,
      actualPrice,
      slippage: slippageBps,
    };
  }

  storeOrder(fill: PaperFill, req: PaperOrderRequest): void {
    const order: Order = {
      id: fill.orderId,
      tokenId: req.tokenId,
      side: req.side,
      price: req.price,
      size: req.size,
      filledSize: fill.filledSize,
      status: fill.filled ? "filled" : "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.orders.set(fill.orderId, order);
  }

  getOrder(orderId: string): Order | null {
    return this.orders.get(orderId) || null;
  }
}
