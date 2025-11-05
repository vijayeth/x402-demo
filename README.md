# Standalone E-commerce Demo

This is a **standalone** demo that uses the **published npm packages** and your **deployed facilitator**.

## What's Inside

- **ecom.ts** - Express server with x402 payment middleware
- **public/index.html** - Beautiful shopping UI
- Uses `x402-v@0.0.1` and `x402-payments@0.0.4` from npm
- Connected to your deployed facilitator: `https://x402-0ti6.onrender.com`

## Quick Start

```bash
# Install dependencies
npm install

# Start the server
npm run dev
```

Then open: http://localhost:4022

## Test Payment Flow

1. Connect your MetaMask wallet
2. Switch to Filecoin Calibration testnet
3. Add items to cart
4. Click "Secure Checkout"
5. Sign the payment authorization
6. Payment processed through your deployed facilitator!

## Configuration

Edit `.env` to change:
- `FACILITATOR_URL` - Your facilitator endpoint
- `ADDRESS` - Your payment recipient address
- `NETWORK` - Default network (filecoin-calibration or sepolia)

## What Makes This Special

✅ **No workspace dependencies** - Uses published npm packages
✅ **Deployed facilitator** - Real production setup
✅ **Complete demo** - Full payment flow from cart to settlement
✅ **Multi-token support** - USDC, JPYC, USDFC
✅ **Multi-network** - Sepolia & Filecoin Calibration

This is exactly how developers will use your x402 packages!
