import pino from "pino";
import { Order } from "./types.js";

const logger = pino({ name: "Orders" });

export class OrderManager {
  private orders = new Map<string, Order>();
  private ordersByTokenId = new Map<string, Set<string>>();

  create(
    tokenId: string,
    side: "buy" | "sell",
    price: number,
    size: number,
    id: string = `order_${Date.now()}_${Math.random().toString(36).slice(2)}`
  ): Order {
    const order: Order = {
      id,
      tokenId,
      side,
      price,
      size,
      filledSize: 0,
      status: "open",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.orders.set(id, order);

    if (!this.ordersByTokenId.has(tokenId)) {
      this.ordersByTokenId.set(tokenId, new Set());
    }
    this.ordersByTokenId.get(tokenId)!.add(id);

    logger.debug({ orderId: id, tokenId, side, price, size }, "Order created");
    return order;
  }

  getById(orderId: string): Order | null {
    return this.orders.get(orderId) || null;
  }

  getByTokenId(tokenId: string): Order[] {
    const ids = this.ordersByTokenId.get(tokenId) || new Set();
    return Array.from(ids).map((id) => this.orders.get(id)).filter((o) => o !== undefined) as Order[];
  }

  updateStatus(orderId: string, status: Order["status"], filledSize?: number): void {
    const order = this.orders.get(orderId);
    if (!order) {
      logger.warn({ orderId }, "Order not found for update");
      return;
    }

    order.status = status;
    if (filledSize !== undefined) {
      order.filledSize = filledSize;
    }
    order.updatedAt = Date.now();
  }

  cancel(orderId: string): void {
    const order = this.orders.get(orderId);
    if (order && order.status === "open") {
      order.status = "cancelled";
      order.updatedAt = Date.now();
      logger.debug({ orderId }, "Order cancelled");
    }
  }

  getOpenOrders(): Order[] {
    return Array.from(this.orders.values()).filter((o) => o.status === "open");
  }

  getOpenOrdersForToken(tokenId: string): Order[] {
    const ids = this.ordersByTokenId.get(tokenId) || new Set();
    return Array.from(ids)
      .map((id) => this.orders.get(id))
      .filter((o) => o !== undefined && o.status === "open") as Order[];
  }

  cancelAll(): void {
    for (const order of this.orders.values()) {
      if (order.status === "open") {
        order.status = "cancelled";
        order.updatedAt = Date.now();
      }
    }
    logger.info("All open orders cancelled");
  }

  clear(): void {
    this.orders.clear();
    this.ordersByTokenId.clear();
  }

  getAll(): Order[] {
    return Array.from(this.orders.values());
  }

  size(): number {
    return this.orders.size;
  }
}
