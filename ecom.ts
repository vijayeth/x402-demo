/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { config } from "dotenv";
import express from "express";
import path from "path";
import {
  Network,
  paymentMiddleware,
  Resource,
} from "@secured-finance/sf-x402-express";

config();

const FACILITATOR_URL = (process.env.FACILITATOR_URL || "http://localhost:3002") as Resource;
const PAY_TO = (process.env.ADDRESS ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;
const NETWORK = (process.env.NETWORK || "filecoin-calibration") as Network;
const PORT = process.env.PORT ? Number(process.env.PORT) : 4022;

if (!FACILITATOR_URL || !PAY_TO) {
  console.error(
    "Missing required environment variables: FACILITATOR_URL or ADDRESS"
  );
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Parse form data
app.use(express.static(path.join(process.cwd(), "public")));

/**
 * Product catalog (simple)
 * price values are in USD as numbers (not strings) for easier math.
 */
const PRODUCTS = [
  { id: "p1", name: "Alpha Sticker", priceUSD: 0.1 },
  { id: "p2", name: "Beta T-shirt", priceUSD: 0.5 },
  { id: "p3", name: "Gamma Mug", priceUSD: 1.25 },
];

/**
 * GET /products
 * Returns product catalog (JSON)
 */
app.get("/products", (req, res) => {
  res.json({ products: PRODUCTS });
});

/**
 * POST /checkout
 * Protected by x402 paymentMiddleware - requires real USDC payment
 *
 * Expects body: { items: [ { id: 'p1', qty: 2 }, ... ] }
 *
 * If payment not provided, returns 402 with paywall
 * If payment valid, returns the receipt
 */
app.post(
  "/checkout",
  (req, res, next) => {
    // Calculate price dynamically based on cart
    // Handle both JSON and form-encoded data
    let items = req.body.items;

    // Get network and token from request body or query param, fallback to env
    const selectedNetwork = req.body.network || req.query.network || NETWORK;
    const selectedToken = req.body.token || req.query.token; // Optional: "USDC", "JPYC", "USDFC"

    // If items is a string (from form data), parse it
    if (typeof items === "string") {
      try {
        items = JSON.parse(items);
      } catch (error: unknown) {
        return res
          .status(400)
          .json({ error: "Invalid items format", details: error });
      }
    }

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items array required" });
    }

    // Compute totals
    let subtotal = 0;
    const lineItems = items.map((it: { id: string; qty: number }) => {
      const prod = PRODUCTS.find((p) => p.id === it.id);
      const qty = Math.max(0, Number(it.qty) || 0);
      const lineTotal = prod ? prod.priceUSD * qty : 0;
      subtotal += lineTotal;
      return {
        id: it.id,
        name: prod?.name ?? "UNKNOWN",
        unitPriceUSD: prod?.priceUSD ?? 0,
        qty,
        lineTotalUSD: Number(lineTotal.toFixed(6)),
      };
    });

    subtotal = Number(subtotal.toFixed(2));

    if (subtotal === 0) {
      return res.json({
        ok: true,
        subtotal,
        lineItems,
        message: "No payment required for $0.00",
      });
    }

    // Store cart info for later
    (req as any).cartInfo = { subtotal, lineItems };

    // Apply x402 middleware with dynamic price, network, and optional token
    const middleware = paymentMiddleware(
      PAY_TO,
      {
        "POST /checkout": {
          price: `$${subtotal}`,
          network: selectedNetwork as any,
          ...(selectedToken && { token: selectedToken as any }),
        },
      },
      {
        url: FACILITATOR_URL,
      }
    );

    middleware(req, res, next);
  },
  (req, res) => {
    // This runs after payment is verified by x402 middleware
    const cartInfo = (req as any).cartInfo;

    res.json({
      ok: true,
      message: "Purchase successful!",
      subtotal: cartInfo.subtotal,
      lineItems: cartInfo.lineItems,
      payment: {
        status: "settled",
        network: NETWORK,
        recipient: PAY_TO,
        timestamp: new Date().toISOString(),
      },
    });
  }
);

/**
 * GET /checkout-page - Checkout page that triggers x402 payment
 */
app.get(
  "/checkout-page",
  (req, res, next) => {
    // Parse items from query string
    const itemsStr = req.query.items as string;
    if (!itemsStr) {
      return res.status(400).send("Missing items");
    }

    // Get network and token from query param, fallback to env
    const selectedNetwork = req.query.network || NETWORK;
    const selectedToken = req.query.token; // Optional: "USDC", "JPYC", "USDFC"

    let items;
    try {
      items = JSON.parse(itemsStr);
    } catch (error: unknown) {
      return res.status(400).send("Invalid items format");
    }

    if (!Array.isArray(items)) {
      return res.status(400).send("items must be an array");
    }

    // Compute totals
    let subtotal = 0;
    const lineItems = items.map((it: any) => {
      const prod = PRODUCTS.find((p) => p.id === it.id);
      const qty = Math.max(0, Number(it.qty) || 0);
      const lineTotal = prod ? prod.priceUSD * qty : 0;
      subtotal += lineTotal;
      return {
        id: it.id,
        name: prod?.name ?? "UNKNOWN",
        unitPriceUSD: prod?.priceUSD ?? 0,
        qty,
        lineTotalUSD: Number(lineTotal.toFixed(6)),
      };
    });

    subtotal = Number(subtotal.toFixed(2));

    if (subtotal === 0) {
      return res.send("No items to purchase");
    }

    // Store cart info
    (req as any).cartInfo = { subtotal, lineItems };

    // Apply x402 middleware with dynamic price, network, and optional token
    const middleware = paymentMiddleware(
      PAY_TO,
      {
        "GET /checkout-page": {
          price: `$${subtotal}`,
          network: selectedNetwork as any,
          ...(selectedToken && { token: selectedToken as any }),
        },
      },
      {
        url: FACILITATOR_URL,
      }
    );

    middleware(req, res, next);
  },
  (req, res) => {
    // This runs after payment is verified
    const cartInfo = (req as any).cartInfo;

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>Payment Successful!</title>
      <style>
        body {
          font-family: system-ui, -apple-system, sans-serif;
          padding: 40px;
          background: #f7f7fb;
          text-align: center;
        }
        .success-box {
          background: white;
          padding: 40px;
          border-radius: 12px;
          max-width: 500px;
          margin: 0 auto;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .emoji { font-size: 64px; margin-bottom: 20px; }
        h1 { color: #22543d; margin: 0 0 10px 0; }
        p { color: #718096; margin: 0 0 30px 0; }
        .btn {
          display: inline-block;
          padding: 12px 24px;
          background: #2b6cb0;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 500;
        }
        .btn:hover { background: #2c5282; }
      </style>
    </head>
    <body>
      <div class="success-box">
        <div class="emoji">🎉</div>
        <h1>Payment Successful!</h1>
        <p>Your purchase has been completed. Thank you for using our shop!</p>
        <a href="/" class="btn">← Back to Shop</a>
      </div>
    </body>
    </html>
  `);
  }
);

/**
 * Example free resource
 */
app.get("/weather", (req, res) => {
  res.json({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

app.listen(PORT, () => {
  console.log(`\n🛒 x402 Demo Shop (LIVE Payments)`);
  console.log(`Server: http://localhost:${PORT}`);
  console.log(`Network: ${NETWORK}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`PayTo Address: ${PAY_TO}\n`);
});
