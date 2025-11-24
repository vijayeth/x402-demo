/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { config } from "dotenv";
import express from "express";
import fs from "fs";
import path from "path";
import { Network, paymentMiddleware, Resource } from "@secured-finance/sf-x402-express";

// Load PPV success template
const PPV_SUCCESS_TEMPLATE = fs.readFileSync(
  path.join(process.cwd(), "public/templates/ppv-success.html"),
  "utf-8"
);

function renderPPVSuccess(data: {
  contentName: string;
  embedHtml: string;
  txHash: string;
  explorerUrl: string;
  shortTxHash: string;
}): string {
  const txDisplay = data.txHash
    ? `<a href="${data.explorerUrl}" target="_blank" title="${data.txHash}">${data.shortTxHash}</a>`
    : `<span style="opacity: 0.6">Settlement pending...</span>`;

  return PPV_SUCCESS_TEMPLATE
    .replace("{{CONTENT_NAME}}", data.contentName)
    .replace("{{EMBED_HTML}}", data.embedHtml)
    .replace("{{TX_DISPLAY}}", txDisplay);
}

config();

const FACILITATOR_URL = (process.env.FACILITATOR_URL || "http://localhost:3002") as Resource;
const PAY_TO = (process.env.ADDRESS ||
  "0x0000000000000000000000000000000000000000") as `0x${string}`;
const NETWORK = (process.env.NETWORK || "filecoin-calibration") as Network;
const PORT = process.env.PORT ? Number(process.env.PORT) : 4022;

if (!FACILITATOR_URL || !PAY_TO) {
  console.error("Missing required environment variables: FACILITATOR_URL or ADDRESS");
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // Parse form data
app.use(express.static(path.join(process.cwd(), "public")));

// In-memory order tracking (in production, use a database)
interface Order {
  orderId: string;
  status: "pending" | "success" | "failed";
  items: any[];
  totalUSD: number;
  network: string;
  token?: string;
  txHash?: string;
  gasUsed?: string;
  error?: string;
  timestamp: string;
}

const orders = new Map<string, Order>();

/**
 * Product catalog (simple)
 * price values are in USD as numbers (not strings) for easier math.
 */
const PRODUCTS = [
  { id: "p1", name: "Alpha Sticker", priceUSD: 0.1 },
  { id: "p2", name: "Beta T-shirt", priceUSD: 0.5 },
  { id: "p3", name: "Gamma Mug", priceUSD: 1.25 },
];

// Helper: Calculate cart totals from items array
function calculateCart(items: Array<{ id: string; qty: number }>) {
  let subtotal = 0;
  const lineItems = items.map(it => {
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
  return { subtotal: Number(subtotal.toFixed(2)), lineItems };
}

app.use((req, res, next) => {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    console.log(
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} → ${res.statusCode} (${duration}ms)`,
    );
  });
  next();
});

/**
 * GET /products
 * Returns product catalog (JSON)
 */
app.get("/products", (req, res) => {
  res.json({ products: PRODUCTS });
});

/**
 * GET /api/config
 * Returns configuration info for debug panel
 */
app.get("/api/config", (req, res) => {
  res.json({
    merchantAddress: PAY_TO,
    facilitatorUrl: FACILITATOR_URL,
    defaultNetwork: NETWORK,
  });
});

/**
 * GET /api/order-status/:orderId
 * Returns the status of an order
 */
app.get("/api/order-status/:orderId", (req, res) => {
  const { orderId } = req.params;

  // Check in-memory store
  const order = orders.get(orderId);

  if (order) {
    return res.json(order);
  }

  // Order not found - might be a client-side only order (from localStorage)
  // Return pending status by default
  res.json({
    orderId,
    status: "pending",
    message: "Order not yet tracked on server",
  });
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
    let items = req.body.items;
    const selectedNetwork = req.body.network || req.query.network || NETWORK;
    const selectedToken = req.body.token || req.query.token;

    if (typeof items === "string") {
      try {
        items = JSON.parse(items);
      } catch {
        return res.status(400).json({ error: "Invalid items format" });
      }
    }

    if (!Array.isArray(items)) {
      return res.status(400).json({ error: "items array required" });
    }

    const { subtotal, lineItems } = calculateCart(items);

    if (subtotal === 0) {
      return res.json({ ok: true, subtotal, lineItems, message: "No payment required for $0.00" });
    }

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

    res.json({
      ok: true,
      message: "Purchase successful!",
      subtotal: cartInfo.subtotal,
      lineItems: cartInfo.lineItems,
      payment: {
        status: "settled",
        network: req.body.network || req.query.network || NETWORK,
        recipient: PAY_TO,
        timestamp: new Date().toISOString(),
      },
    });
  },
);

/**
 * GET /checkout-page - Checkout page that triggers x402 payment
 */
app.get(
  "/checkout-page",
  async (req, res, next) => {
    const itemsStr = req.query.items as string;
    if (!itemsStr) {
      return res.status(400).send("Missing items");
    }

    const selectedNetwork = req.query.network || NETWORK;
    const selectedToken = req.query.token;

    let items;
    try {
      items = JSON.parse(itemsStr);
    } catch {
      return res.status(400).send("Invalid items format");
    }

    if (!Array.isArray(items)) {
      return res.status(400).send("items must be an array");
    }

    const { subtotal, lineItems } = calculateCart(items);

    if (subtotal === 0) {
      return res.send("No items to purchase");
    }

    // Wait for settlement before reading headers
    let settlement = (req as any)?.payment?.settlement;
    if (!settlement?.promise) {
      await new Promise(r => setTimeout(r, 500));
      settlement = (req as any)?.payment?.settlement;
    }
    if (settlement?.promise) {
      await settlement.promise;
    }

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
  async (req, res) => {
    // Check if response is 402 (payment/settlement failed)
    if (res.statusCode === 402) {
      // Return user-friendly error page
      return res.send(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Payment Failed</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              padding: 40px;
              background: #002133;
              min-height: 100vh;
              display: flex;
              align-items: center;
              justify-content: center;
            }
            .error-box {
              background: white;
              padding: 40px;
              border-radius: 12px;
              max-width: 500px;
              text-align: center;
              box-shadow: 0 4px 20px rgba(0,0,0,0.2);
            }
            .emoji { font-size: 64px; margin-bottom: 20px; }
            h1 { color: #c53030; margin: 0 0 10px 0; }
            p { color: #718096; margin: 0 0 20px 0; }
            ul { text-align: left; color: #4a5568; margin: 20px 0; }
            .btn {
              display: inline-block;
              padding: 12px 24px;
              background: #5162FF;
              color: white;
              text-decoration: none;
              border-radius: 8px;
              font-weight: 500;
            }
            .btn:hover { background: #4152E0; }
          </style>
        </head>
        <body>
          <div class="error-box">
            <div class="emoji">❌</div>
            <h1>Payment Failed</h1>
            <p>The payment could not be processed.</p>
            <ul>
              <li><strong>Timing issue:</strong> Try again (most common)</li>
              <li><strong>Insufficient balance:</strong> Check your wallet</li>
              <li><strong>Network issue:</strong> Check connection</li>
            </ul>
            <a href="/" class="btn">← Back to Shop</a>
          </div>
        </body>
        </html>
      `);
    }

    // Wait for settlement if available
    try {
      if ((req as any)?.payment?.settlement?.promise) {
        await (req as any).payment.settlement.promise;
      }
    } catch {
      // Settlement error handled silently
    }

    const cartInfo = (req as any).cartInfo;
    const itemsStr = req.query.items as string;
    const selectedNetwork = req.query.network || NETWORK;
    const selectedToken = req.query.token;

    let items;
    try {
      items = JSON.parse(itemsStr);
    } catch {
      items = [];
    }

    const orderId = `order-${Date.now()}`;

    // Get transaction hash from response headers
    let txHash = res.getHeader("X-PAYMENT-TX-HASH") as string;
    let txExplorer = res.getHeader("X-PAYMENT-TX-EXPLORER") as string;
    const paymentResponse = res.getHeader("X-PAYMENT-RESPONSE") as string;

    // Extract tx hash from payment response if not in headers
    if (paymentResponse) {
      try {
        const settleResponse = JSON.parse(Buffer.from(paymentResponse, "base64").toString());
        if (!txHash && settleResponse.success && settleResponse.transaction) {
          txHash = settleResponse.transaction;
          if (!txExplorer) {
            const explorerBase =
              selectedNetwork === "sepolia"
                ? "https://sepolia.etherscan.io"
                : "https://filecoin-testnet.blockscout.com";
            txExplorer = `${explorerBase}/tx/${txHash}`;
          }
        }
      } catch {
        // Decode error - continue without tx details
      }
    }

    // Create order record with real transaction data
    const order: Order = {
      orderId,
      status: "success",
      items,
      totalUSD: cartInfo.subtotal,
      network: selectedNetwork as string,
      token: selectedToken as string,
      txHash: txHash || undefined, // Real transaction hash from blockchain
      gasUsed: undefined, // Gas info not provided by x402 middleware
      timestamp: new Date().toISOString(),
    };

    // Store order
    orders.set(orderId, order);

    // Check if request wants JSON (from fetch API) or HTML (from browser)
    const acceptsJson = req.headers.accept?.includes("application/json");

    if (acceptsJson) {
      // Return JSON for async checkout flow with transaction details
      res.json({
        ok: true,
        orderId,
        message: "Payment verified and settled",
        subtotal: cartInfo.subtotal,
        lineItems: cartInfo.lineItems,
        payment: {
          status: "success",
          network: selectedNetwork,
          recipient: PAY_TO,
          txHash: txHash || null,
          explorerUrl: txExplorer || null,
          timestamp: order.timestamp,
        },
      });
    } else {
      // Redirect to order success page
      res.redirect(`/order/${orderId}`);
    }
  },
);

/**
 * GET /order/:orderId - View order details
 */
app.get("/order/:orderId", async (req, res) => {
  const { orderId } = req.params;
  const order = orders.get(orderId);

  if (!order) {
    return res.status(404).send("Order not found");
  }

  const network = order.network || NETWORK;
  const txExplorerUrl = order.txHash
    ? network === "sepolia"
      ? `https://sepolia.etherscan.io/tx/${order.txHash}`
      : `https://calibration.filfox.info/en/tx/${order.txHash}`
    : null;

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Order #${orderId.slice(-8)}</title>
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
          font-family: system-ui, -apple-system, sans-serif;
          background: #002133;
          min-height: 100vh;
          padding: 20px;
        }
        .container {
          max-width: 600px;
          margin: 40px auto;
          background: white;
          border-radius: 16px;
          box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
          overflow: hidden;
        }
        .header {
          background: #5162FF;
          color: white;
          padding: 30px;
          text-align: center;
        }
        .header h1 {
          font-size: 1.8rem;
          margin-bottom: 8px;
        }
        .status-badge {
          display: inline-block;
          padding: 8px 16px;
          border-radius: 20px;
          background: rgba(255, 255, 255, 0.25);
          font-size: 0.9rem;
          font-weight: 600;
        }
        .content { padding: 30px; }
        .section { margin-bottom: 25px; }
        .section-title {
          font-size: 1rem;
          font-weight: 600;
          color: #1a202c;
          margin-bottom: 12px;
        }
        .info-grid { display: grid; gap: 10px; }
        .info-row {
          display: flex;
          justify-content: space-between;
          padding: 12px;
          background: #f7fafc;
          border-radius: 8px;
        }
        .info-label { font-weight: 600; color: #4a5568; }
        .info-value {
          color: #2d3748;
          font-family: monospace;
          font-size: 0.9rem;
          text-align: right;
          max-width: 60%;
          word-break: break-all;
        }
        .tx-box {
          background: #f0f4ff;
          border: 2px solid #5162FF;
          border-radius: 12px;
          padding: 16px;
          margin: 16px 0;
        }
        .tx-hash {
          font-family: monospace;
          font-size: 0.85rem;
          color: #5162FF;
          word-break: break-all;
        }
        .btn {
          display: inline-block;
          padding: 12px 24px;
          border-radius: 10px;
          text-decoration: none;
          font-weight: 600;
          margin: 8px;
        }
        .btn-primary {
          background: #5162FF;
          color: white;
        }
        .btn-primary:hover { background: #4152E0; }
        .btn-secondary {
          background: #e2e8f0;
          color: #2d3748;
        }
        .btn-secondary:hover { background: #cbd5e0; }
        .actions { text-align: center; margin-top: 20px; }
        .success-icon { font-size: 3.5rem; margin-bottom: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <div class="success-icon">✅</div>
          <h1>Order Confirmed!</h1>
          <div class="status-badge">Order #${orderId.slice(-8).toUpperCase()}</div>
        </div>
        <div class="content">
          <div class="section">
            <div class="section-title">Order Details</div>
            <div class="info-grid">
              <div class="info-row">
                <span class="info-label">Total:</span>
                <span class="info-value">$${order.totalUSD.toFixed(2)} USD</span>
              </div>
              <div class="info-row">
                <span class="info-label">Network:</span>
                <span class="info-value">${network === "sepolia" ? "Sepolia" : "Filecoin Calibration"}</span>
              </div>
              <div class="info-row">
                <span class="info-label">Token:</span>
                <span class="info-value">${order.token || (network === "sepolia" ? "JPYC" : "USDFC")}</span>
              </div>
            </div>
          </div>
          ${
            order.txHash
              ? `
          <div class="section">
            <div class="section-title">Transaction</div>
            <div class="tx-box">
              <div class="tx-hash">${order.txHash}</div>
            </div>
            ${txExplorerUrl ? `<a href="${txExplorerUrl}" target="_blank" class="btn btn-primary">View on Explorer →</a>` : ""}
          </div>
          `
              : ""
          }
          <div class="actions">
            <a href="/" class="btn btn-secondary">← Back to Shop</a>
          </div>
        </div>
      </div>
    </body>
    </html>
  `);
});

// ========== PAY-PER-VIEW CONTENT ==========
const PPV_CONTENT = [
  {
    id: "song",
    name: "Argy & Omnya - Aria",
    priceUSD: 0.1,
    type: "song",
    url: "https://soundcloud.com/obsessiveprogressive/argy-omnya-aria",
  },
  {
    id: "video",
    name: "Exclusive Video",
    priceUSD: 0.25,
    type: "video",
    url: "https://youtu.be/D1y64Hy-_VI",
  },
];

/**
 * GET /api/ppv - List available PPV content
 */
app.get("/api/ppv", (_req, res) => {
  res.json({ content: PPV_CONTENT });
});

/**
 * GET /ppv/:contentId - Pay to unlock content
 * Protected by x402 paymentMiddleware
 */
app.get(
  "/ppv/:contentId",
  (req, res, next) => {
    const { contentId } = req.params;
    const content = PPV_CONTENT.find(c => c.id === contentId);

    if (!content) {
      return res.status(404).send("Content not found");
    }

    const selectedNetwork = (req.query.network as string) || NETWORK;
    const selectedToken = req.query.token as string;

    // Apply x402 middleware with content price
    const middleware = paymentMiddleware(
      PAY_TO,
      {
        [`GET /ppv/${contentId}`]: {
          price: `$${content.priceUSD}`,
          network: selectedNetwork as any,
          ...(selectedToken && { token: selectedToken as any }),
        },
      },
      { url: FACILITATOR_URL },
    );

    middleware(req, res, next);
  },
  async (req, res) => {
    const { contentId } = req.params;
    const content = PPV_CONTENT.find(c => c.id === contentId) as any;
    const contentName = content?.name || contentId;
    const selectedNetwork = (req.query.network as string) || NETWORK;

    // Wait for txHash from middleware headers (settlement happens async)
    let txHash = "";
    let explorerUrl = "";
    for (let i = 0; i < 120; i++) {  // 120 * 500ms = 60 seconds max
      await new Promise(r => setTimeout(r, 500));

      // Check header directly - middleware sets this when settlement completes
      txHash = (res.getHeader("X-PAYMENT-TX-HASH") as string) || "";
      explorerUrl = (res.getHeader("X-PAYMENT-TX-EXPLORER") as string) || "";

      if (txHash) {
        console.log(`[PPV] Got txHash from header after ${(i + 1) * 500}ms`);
        break;
      }
    }
    const shortTxHash = txHash ? `${txHash.slice(0, 10)}...${txHash.slice(-8)}` : "Pending...";
    if (!explorerUrl && txHash) {
      explorerUrl = selectedNetwork === "sepolia"
        ? `https://sepolia.etherscan.io/tx/${txHash}`
        : `https://calibration.filfox.info/en/message/${txHash}`;
    }

    // Generate embed based on content type
    let embedHtml = "";
    if (content?.type === "song") {
      // SoundCloud embed - extract track URL for widget
      embedHtml = `
        <iframe
          width="100%"
          height="166"
          scrolling="no"
          frameborder="no"
          allow="autoplay"
          src="https://w.soundcloud.com/player/?url=${encodeURIComponent(content.url)}&color=%235162FF&auto_play=true&hide_related=true&show_comments=false&show_user=true&show_reposts=false&show_teaser=false">
        </iframe>`;
    } else if (content?.type === "video") {
      // YouTube embed - extract video ID (handles youtube.com/watch?v= and youtu.be/ formats)
      let videoId = "";
      if (content.url.includes("watch?v=")) {
        videoId = content.url.split("watch?v=")[1].split("&")[0];
      } else if (content.url.includes("youtu.be/")) {
        videoId = content.url.split("youtu.be/")[1].split("?")[0];
      } else {
        videoId = content.url.split("/").pop() || "";
      }
      embedHtml = `
        <iframe
          width="100%"
          height="315"
          src="https://www.youtube.com/embed/${videoId}?autoplay=1"
          frameborder="0"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          allowfullscreen>
        </iframe>`;
    }

    // Payment successful - render success page with embedded media
    res.send(renderPPVSuccess({
      contentName,
      embedHtml,
      txHash,
      explorerUrl,
      shortTxHash,
    }));
  },
);

/**
 * Example free resource
 */
app.get("/weather", (_req, res) => {
  res.json({
    report: {
      weather: "sunny",
      temperature: 70,
    },
  });
});

// ========== PAID API ENDPOINTS ==========

// Helper to create dynamic payment middleware for API endpoints
function createPaidApiRoute(
  path: string,
  price: string,
  handler: (req: express.Request, res: express.Response) => void
) {
  app.get(
    path,
    (req, res, next) => {
      const selectedNetwork = (req.query.network as string) || NETWORK;
      const selectedToken = req.query.token as string;

      const middleware = paymentMiddleware(
        PAY_TO,
        {
          [`GET ${path}`]: {
            price,
            network: selectedNetwork as any,
            ...(selectedToken && { token: selectedToken as any }),
          },
        },
        { url: FACILITATOR_URL }
      );

      middleware(req, res, next);
    },
    handler
  );
}

// GET /api/premium/weather - Detailed weather data ($0.01)
createPaidApiRoute("/api/premium/weather", "$0.01", (_req, res) => {
  res.json({
    premium: true,
    location: "San Francisco, CA",
    current: {
      temperature: 72,
      humidity: 65,
      windSpeed: 12,
      conditions: "Partly Cloudy",
      uvIndex: 6,
    },
    forecast: [
      { day: "Today", high: 75, low: 58, conditions: "Sunny" },
      { day: "Tomorrow", high: 72, low: 55, conditions: "Cloudy" },
      { day: "Wednesday", high: 68, low: 52, conditions: "Rain" },
    ],
    alerts: [],
    lastUpdated: new Date().toISOString(),
  });
});

// GET /api/premium/market - Market data ($0.05)
createPaidApiRoute("/api/premium/market", "$0.05", (_req, res) => {
  res.json({
    premium: true,
    timestamp: new Date().toISOString(),
    assets: [
      { symbol: "BTC", price: 97500.42, change24h: 2.3 },
      { symbol: "ETH", price: 3420.18, change24h: -1.2 },
      { symbol: "FIL", price: 5.82, change24h: 4.7 },
    ],
    marketCap: "3.2T",
    volume24h: "142B",
  });
});

// GET /api/premium/ai - AI-generated content ($0.10)
createPaidApiRoute("/api/premium/ai", "$0.10", (req, res) => {
  const prompt = req.query.prompt || "Hello";
  res.json({
    premium: true,
    prompt,
    response: `AI Response to "${prompt}": This is a simulated AI response. In a real implementation, this would call an actual AI model. The x402 protocol enables pay-per-call API monetization!`,
    model: "gpt-4-simulated",
    tokens: 42,
    timestamp: new Date().toISOString(),
  });
});

// For local development
// app.listen(PORT, () => {
//   console.log(`\n🛒 x402 Demo Shop (LIVE Payments)`);
//   console.log(`Server: http://localhost:${PORT}`);
//   console.log(`Network: ${NETWORK}`);
//   console.log(`Facilitator: ${FACILITATOR_URL}`);
//   console.log(`PayTo Address: ${PAY_TO}\n`);
// });

// Export for Vercel serverless
export default app;
