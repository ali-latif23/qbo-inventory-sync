# QBO Inventory Sync — Setup Guide

## Overview
This app connects to all 3 of your QuickBooks Online companies.
- When an invoice is created in Company 2 or Company 3, it automatically deducts the items from Company 1 (your master inventory).
- Company 1 invoices also deduct from their own inventory.

---

## Step 1: Create an Intuit Developer App (~15 min)

1. Go to https://developer.intuit.com
2. Sign in with your QuickBooks credentials
3. Click **"Create an app"** → Select **"QuickBooks Online and Payments"**
4. Give it a name (e.g. "Inventory Sync")
5. Go to **"Keys & OAuth"** tab
6. Copy your **Client ID** and **Client Secret** — you'll need these

---

## Step 2: Deploy to Railway (~10 min)

1. Go to https://railway.app and create a free account
2. Click **"New Project"** → **"Deploy from GitHub"**
   - OR: Click "Deploy from template" → upload this folder as a zip
3. Once deployed, copy your app's URL (e.g. `https://qbo-sync.railway.app`)

### Set Environment Variables in Railway:
Go to your project → **Variables** tab and add:

```
QBO_CLIENT_ID=           ← from Intuit Developer Console
QBO_CLIENT_SECRET=       ← from Intuit Developer Console
QBO_WEBHOOK_TOKEN=       ← from Step 3 below
APP_URL=                 ← your Railway app URL
QBO_REDIRECT_URI=        ← your Railway app URL + /callback
```

Example:
```
APP_URL=https://qbo-sync.railway.app
QBO_REDIRECT_URI=https://qbo-sync.railway.app/callback
```

---

## Step 3: Register the Redirect URI & Webhook (~5 min)

Back in the **Intuit Developer Console**:

1. Go to **"Keys & OAuth"** → scroll to **"Redirect URIs"**
2. Add: `https://your-app.railway.app/callback`

3. Go to **"Webhooks"** tab
4. Add your webhook endpoint: `https://your-app.railway.app/webhook`
5. Select **"Invoice"** under entity events
6. Copy the **Verifier Token** → paste it as `QBO_WEBHOOK_TOKEN` in Railway

---

## Step 4: Connect Your 3 Companies (~5 min)

1. Open your app dashboard: `https://your-app.railway.app`
2. Click **"Connect Company"** for Company 1 (master inventory)
   - Log in with the QuickBooks account for Company 1
   - Authorize the app
3. Repeat for Company 2 and Company 3

All 3 companies will show as **CONNECTED** in the dashboard.

---

## Step 5: Test It

In the dashboard, use the **Manual Test Sync** panel:
- Select "Company 2" or "Company 3"
- Enter any existing Invoice ID from that company
- Click **Run Sync**
- Watch the activity log — it will show which items were deducted and the before/after quantities

Then create a real invoice in Company 2 or 3 — the webhook will fire automatically and update Company 1's inventory within seconds.

---

## How It Works

```
Invoice created in Company 2 or 3
          ↓
QuickBooks sends webhook to your app
          ↓
App fetches full invoice details
          ↓
For each line item:
  → Looks up item by name in Company 1
  → Deducts quantity sold from QtyOnHand
  → Updates Company 1 inventory via API
          ↓
Result logged in dashboard
```

---

## Important Notes

- Items are matched by **name** across companies — make sure item names are consistent
- Only **Inventory** type items are synced (services/non-inventory are skipped)
- Inventory will never go below 0
- All sync activity is logged in the dashboard
- Tokens auto-refresh — no need to reconnect after authorization

---

## Support

If you run into issues, check the **Activity Log** in the dashboard first — errors are logged with details.

Common issues:
- **"Item not found in master inventory"** → Item name in Company 2/3 doesn't match Company 1 exactly
- **"No refresh token"** → Company needs to be reconnected (click Disconnect then Connect again)
- **Webhook not firing** → Check that the webhook URL is registered in Intuit Developer Console
