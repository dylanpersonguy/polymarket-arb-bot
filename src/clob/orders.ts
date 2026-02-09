import pino from "pino";
import { Order } from "./types.js";

const logger = pino({ name: "Orders" });

export class OrderManager {
  private orders = new Map<string, Order>();

  track(order: Order): void {
    this.orders.set(order.id, order);
  }

  get(orderId: string): Order | null {
    return this.orders.get(orderId) ?? null;
  }

  updateStatus(orderId: string, status: Order["status"], filledSize?: number): void {
    const order = this.orders.get(orderId);
    if (!order) return;
    order.status = status;
    if (filledSize !== undefined) order.filledSize = filledSize;
    order.updatedAt = Date.now();
  }

  getOpenOrders(): Order[] {
    return [...this.orders.values()].filter((o) => o.status === "open");
  }

  openCount(): number {
    return this.getOpenOrders().length;
  }

  cancelAll(): void {
    for (const o of this.orders.values()) {
      if (o.status === "open") {
        o.status = "cancelled";
        o.updatedAt = Date.now();
      }
    }
    logger.info("All open orders cancelled locally");
  }
}
