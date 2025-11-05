import { config } from "dotenv";
import cors from "cors";
import express from "express";
import path from "path";
import { paymentMiddleware, Resource } from "x402-payments";

config();

const FACILITATOR_URL = ((process.env.FACILITATOR_URL as string) || "https://x402-0ti6.onrender.com") as Resource;
const PAY_TO = (process.env.ADDRESS ||
  "0x3D0eAE988A2790EE25316FEdaCC87883438FC303") as `0x${string}`;
const NETWORK = (process.env.NETWORK || "filecoin-calibration") as any;
const PORT = process.env.PORT ? Number(process.env.PORT) : 4022;

if (!FACILITATOR_URL || !PAY_TO) {
  console.error("Missing required environment variables: FACILITATOR_URL or ADDRESS");
  process.exit(1);
}

const app = express();

// CORS configuration - allows frontend to be deployed separately
app.use(cors({
  origin: true, // Allow all origins in development, restrict in production
  credentials: true,
  exposedHeaders: ['X-PAYMENT-TX-HASH', 'X-PAYMENT-EXPLORER-URL']
}));

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
      } catch (e) {
        return res.status(400).json({ error: "Invalid items format" });
      }
    }

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items array required" });
    }

    // Compute totals
    let subtotal = 0;
    const lineItems = items.map((it: any) => {
      const prod = PRODUCTS.find(p => p.id === it.id);
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
      },
    );

    middleware(req, res, next);
  },
  (req, res) => {
    // This runs after payment is verified by x402 middleware
    const cartInfo = (req as any).cartInfo;

    // Get transaction hash from response headers (set by x402 middleware)
    const txHash = res.getHeader("X-PAYMENT-TX-HASH") as string;
    const explorerUrl = res.getHeader("X-PAYMENT-EXPLORER-URL") as string;

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
        transactionHash: txHash,
        explorerUrl: explorerUrl,
      },
    });
  },
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
    } catch (e) {
      return res.status(400).send("Invalid items format");
    }

    if (!Array.isArray(items)) {
      return res.status(400).send("items must be an array");
    }

    // Compute totals
    let subtotal = 0;
    const lineItems = items.map((it: any) => {
      const prod = PRODUCTS.find(p => p.id === it.id);
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
      },
    );

    middleware(req, res, next);
  },
  (req, res) => {
    // This runs after payment is verified
    const cartInfo = (req as any).cartInfo;

    // Get transaction hash from response headers (set by x402 middleware)
    const txHash = res.getHeader("X-PAYMENT-TX-HASH") as string;
    const explorerUrl = res.getHeader("X-PAYMENT-EXPLORER-URL") as string;

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
          max-width: 600px;
          margin: 0 auto;
          box-shadow: 0 2px 8px rgba(0,0,0,0.1);
        }
        .emoji { font-size: 64px; margin-bottom: 20px; }
        h1 { color: #22543d; margin: 0 0 10px 0; }
        p { color: #718096; margin: 0 0 20px 0; }
        .tx-info {
          background: #f7fafc;
          padding: 20px;
          border-radius: 8px;
          margin: 20px 0;
          text-align: left;
        }
        .tx-label {
          font-size: 0.85rem;
          color: #718096;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 8px;
        }
        .tx-hash {
          font-family: monospace;
          font-size: 0.9rem;
          color: #2d3748;
          word-break: break-all;
          background: white;
          padding: 10px;
          border-radius: 4px;
          border: 1px solid #e2e8f0;
        }
        .btn {
          display: inline-block;
          padding: 12px 24px;
          background: #2b6cb0;
          color: white;
          text-decoration: none;
          border-radius: 8px;
          font-weight: 500;
          margin: 10px 5px;
        }
        .btn:hover { background: #2c5282; }
        .btn-secondary {
          background: #48bb78;
        }
        .btn-secondary:hover { background: #38a169; }
      </style>
    </head>
    <body>
      <div class="success-box">
        <div class="emoji">🎉</div>
        <h1>Payment Successful!</h1>
        <p>Your purchase has been completed. Thank you for using our shop!</p>
        ${txHash ? `
        <div class="tx-info">
          <div class="tx-label">Transaction Hash</div>
          <div class="tx-hash">${txHash}</div>
        </div>
        ${explorerUrl ? `<a href="${explorerUrl}" target="_blank" class="btn btn-secondary">🔍 View on Explorer</a>` : ''}
        ` : ''}
        <a href="/" class="btn">← Back to Shop</a>
      </div>
    </body>
    </html>
  `);
});

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
