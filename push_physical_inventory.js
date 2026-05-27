/**
 * push_physical_inventory.js
 *
 * Reads the physical inventory Excel sheet and pushes each counted item
 * to ProClean's QBO as an inventory adjustment (sets QtyOnHand directly).
 *
 * Usage:
 *   node push_physical_inventory.js --file newinvupdate.xlsx [--dry-run]
 *
 * Options:
 *   --file     Path to the physical inventory Excel file (required)
 *   --dry-run  Preview what would be updated without writing to QBO
 *
 * Place this file in the same directory as server.js.
 * Requires the same DATABASE_URL and QBO env vars as server.js.
 */

require('dotenv').config(); // optional: if you use a .env file locally
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const { Pool } = require('pg');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

// ─── CONFIG ─────────────────────────────────────────────────────────────────

const QBO_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';

const CONFIG = {
  clientId: process.env.QBO_CLIENT_ID,
  clientSecret: process.env.QBO_CLIENT_SECRET,
};

// ─── ARGS ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fileArg = args.find((_, i) => args[i - 1] === '--file') || args.find(a => a.endsWith('.xlsx') || a.endsWith('.csv'));
const DRY_RUN = args.includes('--dry-run');

if (!fileArg) {
  console.error('❌  Usage: node push_physical_inventory.js --file newinvupdate.xlsx [--dry-run]');
  process.exit(1);
}

if (DRY_RUN) console.log('🔍  DRY RUN — no changes will be written to QBO\n');

// ─── DATABASE ────────────────────────────────────────────────────────────────

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal')
    ? false
    : { rejectUnauthorized: false },
});

// Load ProClean (company1) tokens and realmId from DB — same as server.js
async function loadCompany1() {
  const res = await pool.query(`SELECT value FROM app_state WHERE key = 'companies'`);
  if (!res.rows.length) throw new Error('No companies found in DB. Is the app running and connected?');
  const companies = res.rows[0].value;
  const company1 = companies['company1'];
  if (!company1?.tokens) throw new Error('ProClean (company1) is not connected. Connect it in the dashboard first.');
  return company1;
}

// ─── AUTH ────────────────────────────────────────────────────────────────────

async function getAccessToken(company) {
  const { tokens } = company;
  const expiresAt = (tokens.obtained_at || 0) + (tokens.expires_in - 60) * 1000;

  if (Date.now() < expiresAt) {
    return tokens.access_token;
  }

  // Refresh
  console.log('🔄  Access token expired, refreshing...');
  const creds = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    }),
  });

  const newTokens = await res.json();
  if (!newTokens.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(newTokens)}`);

  // Save refreshed tokens back to DB
  const companiesRes = await pool.query(`SELECT value FROM app_state WHERE key = 'companies'`);
  const companies = companiesRes.rows[0].value;
  companies['company1'].tokens = { ...newTokens, obtained_at: Date.now() };
  await pool.query(
    `INSERT INTO app_state (key, value, updated_at) VALUES ('companies', $1, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
    [JSON.stringify(companies)]
  );

  console.log('✅  Token refreshed and saved\n');
  return newTokens.access_token;
}

// ─── QBO API ─────────────────────────────────────────────────────────────────

async function qboGet(realmId, token, endpoint) {
  const url = `${QBO_BASE}/${realmId}/${endpoint}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  return res.json();
}

async function queryItemByName(realmId, token, name) {
  const encoded = encodeURIComponent(`SELECT * FROM Item WHERE Name = '${name.replace(/'/g, "\\'")}'`);
  const data = await qboGet(realmId, token, `query?query=${encoded}`);
  return data.QueryResponse?.Item?.[0] || null;
}

async function setInventoryQty(realmId, token, item, newQty) {
  const url = `${QBO_BASE}/${realmId}/item`;
  const body = {
    Id: item.Id,
    SyncToken: item.SyncToken,
    sparse: true,
    QtyOnHand: newQty,
    InvStartDate: new Date().toISOString().split('T')[0],
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

// ─── READ EXCEL ───────────────────────────────────────────────────────────────

function readInventorySheet(filePath) {
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const items = [];
  for (const row of rows) {
    const name = row[0];
    const qty = row[2];

    // Skip header rows, empty rows, null quantities
    if (!name || typeof name !== 'string') continue;
    if (name === 'Product/Service' || name === 'Physical Inventory Worksheet') continue;
    // Blank quantity = 0 (not counted = out of stock)
    const resolvedQty = (qty === null || qty === undefined || qty === '') ? 0 : qty;
    if (typeof resolvedQty !== 'number') continue;

    items.push({ name: name.trim(), qty: resolvedQty });
  }

  return items;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  const filePath = path.resolve(fileArg);
  if (!fs.existsSync(filePath)) {
    console.error(`❌  File not found: ${filePath}`);
    process.exit(1);
  }

  console.log(`📂  Reading: ${filePath}`);
  const items = readInventorySheet(filePath);
  console.log(`📦  Found ${items.length} items with counts\n`);

  // Load ProClean from DB
  const company1 = await loadCompany1();
  const { realmId } = company1;
  const token = await getAccessToken(company1);

  console.log(`🏢  ProClean realmId: ${realmId}\n`);
  console.log('─'.repeat(70));

  const results = { updated: [], skipped: [], errors: [] };

  for (const { name, qty } of items) {
    try {
      const item = await queryItemByName(realmId, token, name);

      if (!item) {
        console.log(`⚠️   NOT FOUND     ${name}`);
        results.skipped.push({ name, reason: 'Not found in QBO' });
        continue;
      }

      if (item.Type !== 'Inventory') {
        console.log(`⏭️   SKIPPED        ${name} (Type: ${item.Type})`);
        results.skipped.push({ name, reason: `Non-inventory type: ${item.Type}` });
        continue;
      }

      const currentQty = item.QtyOnHand;
      const diff = qty - currentQty;
      const diffStr = diff >= 0 ? `+${diff}` : `${diff}`;

      if (DRY_RUN) {
        console.log(`🔍  DRY RUN        ${name.padEnd(35)} QBO: ${String(currentQty).padStart(8)}  →  New: ${String(qty).padStart(8)}  (${diffStr})`);
        results.updated.push({ name, currentQty, newQty: qty, diff });
        continue;
      }

      const result = await setInventoryQty(realmId, token, item, qty);

      if (result.Item) {
        console.log(`✅  UPDATED        ${name.padEnd(35)} ${String(currentQty).padStart(8)}  →  ${String(qty).padStart(8)}  (${diffStr})`);
        results.updated.push({ name, currentQty, newQty: qty, diff });
      } else {
        const errMsg = JSON.stringify(result.Fault || result);
        console.log(`❌  ERROR          ${name} — ${errMsg}`);
        results.errors.push({ name, error: errMsg });
      }

      // Small delay to avoid QBO rate limits
      await new Promise(r => setTimeout(r, 200));

    } catch (err) {
      console.log(`❌  EXCEPTION      ${name} — ${err.message}`);
      results.errors.push({ name, error: err.message });
    }
  }

  // ─── SUMMARY ──────────────────────────────────────────────────────────────
  console.log('\n' + '─'.repeat(70));
  console.log(`\n📊  SUMMARY`);
  console.log(`   ${DRY_RUN ? 'Would update' : 'Updated'}:  ${results.updated.length} items`);
  console.log(`   Skipped:   ${results.skipped.length} items`);
  console.log(`   Errors:    ${results.errors.length} items`);

  if (results.skipped.length) {
    console.log('\n⚠️   SKIPPED ITEMS (not in QBO or non-inventory):');
    results.skipped.forEach(s => console.log(`   - ${s.name}: ${s.reason}`));
  }

  if (results.errors.length) {
    console.log('\n❌  ERRORS:');
    results.errors.forEach(e => console.log(`   - ${e.name}: ${e.error}`));
  }

  if (!DRY_RUN && results.updated.length) {
    console.log(`\n✅  Done. ${results.updated.length} items updated in ProClean QBO.`);
  } else if (DRY_RUN) {
    console.log(`\n🔍  Dry run complete. Re-run without --dry-run to apply changes.`);
  }

  await pool.end();
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  pool.end();
  process.exit(1);
});
