import pino from "pino";
import { ClobClient } from "./clob/client.js";
import { loadEnv } from "./config/load.js";

const logger = pino({ name: "CLI" });

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const env = loadEnv();
  const client = new ClobClient(env);
  await client.initialize();

  switch (command) {
    case "keys": {
      logger.info("Validating API credentials...");

      if (!env.POLYMARKET_PRIVATE_KEY) {
        logger.error("POLYMARKET_PRIVATE_KEY not set");
        process.exit(1);
      }

      logger.info("✓ Private key is set");

      if (env.POLYMARKET_API_KEY) {
        logger.info("✓ API key is set");
      }

      logger.info("✓ All required credentials are present");
      break;
    }

    case "book": {
      const tokenIndex = args.indexOf("--token");
      if (tokenIndex === -1 || !args[tokenIndex + 1]) {
        logger.error("Usage: pnpm bot:book --token <tokenId>");
        process.exit(1);
      }

      const tokenId = args[tokenIndex + 1];
      logger.info({ tokenId }, "Fetching order book");

      try {
        const book = await client.getOrderBook(tokenId);
        logger.info(
          {
            tokenId: book.tokenId,
            bestBid: book.bestBidPrice,
            bidSize: book.bestBidSize,
            bestAsk: book.bestAskPrice,
            askSize: book.bestAskSize,
            timestamp: new Date(book.lastUpdatedMs).toISOString(),
          },
          "Order book"
        );
      } catch (error) {
        logger.error({ error }, "Failed to fetch order book");
        process.exit(1);
      }
      break;
    }

    default: {
      logger.info("Available commands:");
      logger.info("  pnpm bot:keys     - Validate API credentials");
      logger.info("  pnpm bot:book     - View order book for a token");
      logger.info("  pnpm bot:run      - Start the arbitrage bot");
      process.exit(0);
    }
  }

  process.exit(0);
}

main().catch((error) => {
  logger.error({ error }, "CLI error");
  process.exit(1);
});
