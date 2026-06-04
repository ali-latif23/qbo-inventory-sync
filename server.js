const express = require('express');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const supabaseAdmin = createClient(
  'https://phyxlpdfvruyigmpdqqi.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const app = express();

// ─── DATABASE SETUP ──────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('railway.internal') ? false : { rejectUnauthorized: false }
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_state (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS sync_logs (
      id TEXT PRIMARY KEY,
      timestamp TIMESTAMPTZ NOT NULL,
      type TEXT NOT NULL,
      message TEXT NOT NULL,
      details JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS processed_transactions (
      id TEXT PRIMARY KEY,
      company_key TEXT NOT NULL,
      transaction_type TEXT NOT NULL,
      processed_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS app_inventory (
      item_name TEXT PRIMARY KEY,
      sku TEXT,
      qty_on_hand NUMERIC NOT NULL DEFAULT 0,
      last_updated TIMESTAMPTZ DEFAULT NOW(),
      last_updated_by TEXT DEFAULT 'system'
    );
    CREATE TABLE IF NOT EXISTS proclean_items (
      qbo_id TEXT PRIMARY KEY,
      sync_token TEXT NOT NULL DEFAULT '0',
      name TEXT NOT NULL,
      sku TEXT,
      uom TEXT,
      qty_on_hand NUMERIC NOT NULL DEFAULT 0,
      unit_price NUMERIC NOT NULL DEFAULT 0,
      purchase_cost NUMERIC NOT NULL DEFAULT 0,
      description TEXT,
      item_type TEXT DEFAULT 'Inventory',
      last_synced TIMESTAMPTZ DEFAULT NOW(),
      last_updated_by TEXT DEFAULT 'qbo'
    );
    -- Add columns if table already exists (safe migration)
    ALTER TABLE proclean_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE proclean_items ADD COLUMN IF NOT EXISTS purchase_cost NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE proclean_items ADD COLUMN IF NOT EXISTS description TEXT;
    CREATE TABLE IF NOT EXISTS pk_inventory (
      pk_name TEXT PRIMARY KEY,
      proclean_name TEXT,
      uom TEXT NOT NULL DEFAULT 'DZ',
      qty_in_pakistan NUMERIC NOT NULL DEFAULT 0,
      target_stock NUMERIC,
      notes TEXT,
      is_hot BOOLEAN NOT NULL DEFAULT FALSE,
      last_updated TIMESTAMPTZ DEFAULT NOW()
    );
    ALTER TABLE pk_inventory ADD COLUMN IF NOT EXISTS target_stock NUMERIC;
    ALTER TABLE pk_inventory ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE pk_inventory ADD COLUMN IF NOT EXISTS is_hot BOOLEAN NOT NULL DEFAULT FALSE;
    CREATE TABLE IF NOT EXISTS pk_shipments (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      eta DATE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS pk_shipment_items (
      id SERIAL PRIMARY KEY,
      shipment_id INTEGER NOT NULL REFERENCES pk_shipments(id) ON DELETE CASCADE,
      pk_name TEXT NOT NULL,
      quantity NUMERIC NOT NULL DEFAULT 0,
      UNIQUE(shipment_id, pk_name)
    );
    CREATE TABLE IF NOT EXISTS proclean_movements (
      id SERIAL PRIMARY KEY,
      qbo_id TEXT NOT NULL REFERENCES proclean_items(qbo_id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      quantity NUMERIC NOT NULL,
      movement_type TEXT NOT NULL,
      source TEXT,
      note TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);
  console.log('✅ Database initialized');
}

async function appInventoryAdjust(itemName, delta, reason) {
  try {
    await pool.query(`
      INSERT INTO app_inventory (item_name, qty_on_hand, last_updated, last_updated_by)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (item_name) DO UPDATE
        SET qty_on_hand = app_inventory.qty_on_hand + $2,
            last_updated = NOW(),
            last_updated_by = $3
    `, [itemName, delta, reason]);
  } catch (err) {
    console.error(`App inventory adjust error for ${itemName}:`, err.message);
  }
}



async function isAlreadyProcessed(companyKey, transactionType, transactionId) {
  const key = `${companyKey}_${transactionType}_${transactionId}`;
  try {
    const res = await pool.query('SELECT id FROM processed_transactions WHERE id = $1', [key]);
    return res.rows.length > 0;
  } catch { return false; }
}

async function markAsProcessed(companyKey, transactionType, transactionId) {
  const key = `${companyKey}_${transactionType}_${transactionId}`;
  await pool.query(
    'INSERT INTO processed_transactions (id, company_key, transaction_type) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
    [key, companyKey, transactionType]
  );
}


// ─── CONFIG ────────────────────────────────────────────────────────────────
const CONFIG = {
  clientId: process.env.QBO_CLIENT_ID,
  clientSecret: process.env.QBO_CLIENT_SECRET,
  redirectUri: process.env.QBO_REDIRECT_URI || 'http://localhost:3000/callback',
  webhookVerifierToken: process.env.QBO_WEBHOOK_TOKEN,
  port: process.env.PORT || 3000,
  // Company 1 is the MASTER inventory company
  companies: {
    company1: { name: 'ProClean', realmId: null, tokens: null },
    company2: { name: 'The Linen Pros', realmId: null, tokens: null },
    company3: { name: 'Brown Eyed Girl', realmId: null, tokens: null },
  }
};

const QBO_BASE = 'https://quickbooks.api.intuit.com/v3/company';
const AUTH_BASE = 'https://appcenter.intuit.com/connect/oauth2';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const SCOPES = 'com.intuit.quickbooks.accounting';

// ─── PERSISTENT STORAGE (PostgreSQL) ─────────────────────────────────────────
async function loadData() {
  const res = await pool.query(`SELECT key, value FROM app_state WHERE key IN ('companies', 'stats', 'pendingStates')`);
  const data = { companies: {}, stats: { totalSynced: 0, errors: 0, lastSync: null }, pendingStates: {} };
  for (const row of res.rows) {
    data[row.key] = row.value;
  }
  return data;
}

async function saveField(key, value) {
  await pool.query(`
    INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, NOW())
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
  `, [key, JSON.stringify(value)]);
}

async function saveData(data) {
  await Promise.all([
    saveField('companies', data.companies),
    saveField('stats', data.stats),
    saveField('pendingStates', data.pendingStates || {})
  ]);
}

async function addLog(entry) {
  await pool.query(
    `INSERT INTO sync_logs (id, timestamp, type, message, details) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
    [entry.id, entry.timestamp, entry.type, entry.message, JSON.stringify(entry.details)]
  );
}

async function getLogs(limit = 50) {
  const res = await pool.query(`SELECT * FROM sync_logs ORDER BY timestamp DESC LIMIT $1`, [limit]);
  return res.rows.map(r => ({ ...r, details: r.details }));
}

let appData = { companies: {}, stats: { totalSynced: 0, errors: 0, lastSync: null }, pendingStates: {} };

// ─── MIDDLEWARE ─────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// Raw body for webhook verification
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ─── API AUTH MIDDLEWARE ──────────────────────────────────────────────────────
// Every /api/* request must carry a valid Supabase JWT.
// Non-API routes (/webhook, /connect, /callback, /eula, /privacy, static files)
// are unaffected — they don't match this path prefix.
app.use('/api', async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !user) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
  req.user = user;
  next();
});

// ─── HELPERS ────────────────────────────────────────────────────────────────
function log(type, message, details = {}) {
  const entry = {
    id: Date.now() + Math.random().toString(36).slice(2),
    timestamp: new Date().toISOString(),
    type,
    message,
    details
  };
  if (type === 'success') appData.stats.totalSynced++;
  if (type === 'error') appData.stats.errors++;
  if (type === 'success' || type === 'error') appData.stats.lastSync = entry.timestamp;
  // Fire and forget async saves
  addLog(entry).catch(e => console.error('Log save error:', e));
  saveField('stats', appData.stats).catch(e => console.error('Stats save error:', e));
  console.log(`[${type.toUpperCase()}] ${message}`, details);
  return entry;
}

function getCompanyByRealmId(realmId) {
  return Object.entries(appData.companies).find(([, c]) => c.realmId === realmId);
}

function getMasterCompany() {
  return appData.companies['company1'];
}

// ─── OAUTH TOKEN MANAGEMENT ──────────────────────────────────────────────────
async function refreshToken(companyKey) {
  const company = appData.companies[companyKey];
  if (!company?.tokens?.refresh_token) throw new Error(`No refresh token for ${companyKey}`);

  const creds = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: company.tokens.refresh_token
    })
  });

  const tokens = await res.json();
  if (!tokens.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(tokens)}`);

  appData.companies[companyKey].tokens = {
    ...tokens,
    obtained_at: Date.now()
  };
  saveData(appData);
  return tokens.access_token;
}

async function getAccessToken(companyKey) {
  const company = appData.companies[companyKey];
  if (!company?.tokens) throw new Error(`Company ${companyKey} not connected`);

  const expiresAt = (company.tokens.obtained_at || 0) + (company.tokens.expires_in - 60) * 1000;
  if (Date.now() > expiresAt) {
    return await refreshToken(companyKey);
  }
  return company.tokens.access_token;
}

// ─── QBO API CALLS ───────────────────────────────────────────────────────────
async function qboGet(companyKey, endpoint) {
  const company = appData.companies[companyKey];
  const token = await getAccessToken(companyKey);
  const url = `${QBO_BASE}/${company.realmId}/${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    }
  });
  return res.json();
}

async function qboPost(companyKey, endpoint, body) {
  const company = appData.companies[companyKey];
  const token = await getAccessToken(companyKey);
  const url = `${QBO_BASE}/${company.realmId}/${endpoint}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

async function getInvoice(companyKey, invoiceId) {
  // Try direct ID lookup first
  const data = await qboGet(companyKey, `invoice/${invoiceId}`);
  if (data.Invoice) return data.Invoice;

  // If not found, try querying by DocNumber (display number)
  const encoded = encodeURIComponent(`SELECT * FROM Invoice WHERE DocNumber = '${invoiceId}'`);
  const queryData = await qboGet(companyKey, `query?query=${encoded}`);
  if (queryData.QueryResponse?.Invoice?.length > 0) {
    return queryData.QueryResponse.Invoice[0];
  }

  if (data.Fault) {
    log('error', `QBO API fault fetching invoice ${invoiceId}`, { fault: JSON.stringify(data.Fault) });
  }
  return null;
}

async function getInvoiceWithRetry(companyKey, invoiceId, retries = 3, delayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    const invoice = await getInvoice(companyKey, invoiceId);
    if (invoice) return invoice;
    if (i < retries - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }
  return null;
}

async function getItem(companyKey, itemId) {
  const data = await qboGet(companyKey, `item/${itemId}`);
  return data.Item;
}

async function queryItems(companyKey, name) {
  const encoded = encodeURIComponent(`SELECT * FROM Item WHERE Name = '${name.replace(/'/g, "\\'")}'`);
  const data = await qboGet(companyKey, `query?query=${encoded}`);
  return data.QueryResponse?.Item || [];
}

async function updateInventory(itemId, newQty, syncToken, companyKey) {
  const company = appData.companies[companyKey];
  const token = await getAccessToken(companyKey);
  const url = `${QBO_BASE}/${company.realmId}/item`;

  const body = {
    Id: itemId,
    SyncToken: syncToken,
    sparse: true,
    QtyOnHand: newQty,
    InvStartDate: new Date().toISOString().split('T')[0]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: JSON.stringify(body)
  });
  return res.json();
}

// ─── CORE SYNC LOGIC ─────────────────────────────────────────────────────────

// Invoice in any company → DECREASE master inventory
async function processInvoiceSync(sourceCompanyKey, invoiceId) {
  const sourceCompany = appData.companies[sourceCompanyKey];
  if (!sourceCompany) throw new Error(`Unknown company: ${sourceCompanyKey}`);

  log('info', `Processing invoice ${invoiceId} from ${sourceCompany.name}`, { sourceCompanyKey, invoiceId });

  const invoice = await getInvoiceWithRetry(sourceCompanyKey, invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found - may not be accessible via API yet`);
  if (invoice.status === 'Void' || invoice.PrivateNote?.includes('__synced__')) return;

  // ── Date guard: skip invoices older than 7 days ──────────────────────────
  // Prevents replayed/historical webhooks from incorrectly deducting stock.
  // QBO sometimes replays old webhook events during app restarts or outages.
  const txnDate = invoice.TxnDate; // format: "YYYY-MM-DD"
  if (txnDate) {
    const invoiceAge = (Date.now() - new Date(txnDate).getTime()) / (1000 * 60 * 60 * 24);
    if (invoiceAge > 7) {
      log('warning', `Invoice ${invoiceId} from ${sourceCompany.name} is ${Math.floor(invoiceAge)} days old — skipping to prevent replay`, { invoiceId, txnDate, ageInDays: Math.floor(invoiceAge) });
      return;
    }
  }

  // ── Verify invoice ID matches what we requested ──────────────────────────
  // Guards against QBO returning a different invoice than requested.
  if (invoice.Id && invoice.Id !== String(invoiceId)) {
    log('error', `Invoice ID mismatch: requested ${invoiceId}, got ${invoice.Id} — skipping`, { invoiceId, returnedId: invoice.Id });
    return;
  }

  const lineItems = invoice.Line?.filter(l => l.DetailType === 'SalesItemLineDetail') || [];
  if (lineItems.length === 0) {
    log('info', `Invoice ${invoiceId} has no inventory line items`, {});
    return;
  }

  const results = [];

  for (const line of lineItems) {
    const detail = line.SalesItemLineDetail;
    const itemRef = detail?.ItemRef;
    if (!itemRef) continue;

    // Use Qty directly — never fall back to Amount/Price calculation which can be wildly wrong
    const qty = detail.Qty;
    if (!qty || qty <= 0) {
      log('warning', `Invoice ${invoiceId} line item has invalid qty: ${qty} — skipping`, { itemName: itemRef.name, qty });
      continue;
    }
    const itemName = itemRef.name;

    try {
      // Find item in master company (Company 1) by name
      const masterItems = await queryItems('company1', itemName);

      if (masterItems.length === 0) {
        log('warning', `Item "${itemName}" not found in master inventory`, { itemName, invoiceId });
        continue;
      }

      const masterItem = masterItems[0];
      if (masterItem.Type !== 'Inventory') {
        log('info', `Item "${itemName}" is not inventory type, skipping`, { itemName });
        continue;
      }

      const currentQty = masterItem.QtyOnHand || 0;
      const newQty = currentQty - qty;

      const updateResult = await updateInventory(masterItem.Id, newQty, masterItem.SyncToken, 'company1');

      if (updateResult.Item) {
        results.push({ itemName, deducted: qty, from: currentQty, to: newQty });
        log('success', `Inventory updated: "${itemName}" ${currentQty} → ${newQty} (deducted ${qty})`, {
          itemName, currentQty, newQty, qty, invoiceId,
          sourceCompany: sourceCompany.name
        });
        await appInventoryAdjust(itemName, -qty, `invoice:${invoiceId}:${sourceCompany.name}`);
        // Update proclean_items tracker
        try {
          await pool.query(
            'UPDATE proclean_items SET qty_on_hand=$1, sync_token=$2, last_synced=NOW(), last_updated_by=$3 WHERE qbo_id=$4',
            [newQty, updateResult.Item.SyncToken, 'invoice:' + sourceCompany.name, masterItem.Id]
          );
          await pcLogMovement(masterItem.Id, itemName, qty, 'deduction', 'invoice:' + sourceCompany.name, 'Invoice ' + invoiceId + ' from ' + sourceCompany.name);
        } catch(e) { console.error('proclean_items update error:', e.message); }
      } else {
        log('error', `Failed to update "${itemName}"`, { updateResult, itemName });
      }
    } catch (err) {
      log('error', `Error syncing item "${itemName}": ${err.message}`, { itemName, error: err.message });
    }
  }

  return results;
}

// ProClean invoice → only update app tracker (QBO handles QtyOnHand natively)
async function processInvoiceSyncAppOnly(invoiceId) {
  const data = await getInvoiceWithRetry('company1', invoiceId);
  const invoice = data?.Invoice;
  if (!invoice) return;

  const lineItems = invoice.Line?.filter(l => l.DetailType === 'SalesItemLineDetail') || [];
  for (const line of lineItems) {
    const detail = line.SalesItemLineDetail;
    const itemName = detail?.ItemRef?.name;
    if (!itemName) continue;
    const qty = detail.Qty || 0;
    await appInventoryAdjust(itemName, -qty, `invoice:${invoiceId}:ProClean`);
  }
  log('info', `App tracker updated for ProClean invoice ${invoiceId}`, { invoiceId });
}

// Bill from ProClean → only update app tracker (QBO handles QtyOnHand natively)
async function processBillAppOnly(billId) {
  const data = await qboGet('company1', `bill/${billId}`);
  const bill = data?.Bill;
  if (!bill) return;

  const lineItems = bill.Line?.filter(l => l.DetailType === 'ItemBasedExpenseLineDetail') || [];
  for (const line of lineItems) {
    const detail = line.ItemBasedExpenseLineDetail;
    const itemName = detail?.ItemRef?.name;
    if (!itemName) continue;
    const qty = detail.Qty || 0;
    await appInventoryAdjust(itemName, qty, `bill:${billId}:ProClean`);
  }
  log('info', `App tracker updated for ProClean bill ${billId} (+stock)`, { billId });
}


app.post('/webhook', async (req, res) => {
  // Verify webhook signature
  const signature = req.headers['intuit-signature'];
  const payload = req.body;

  if (CONFIG.webhookVerifierToken && signature) {
    const hash = crypto
      .createHmac('sha256', CONFIG.webhookVerifierToken)
      .update(payload)
      .digest('base64');
    if (hash !== signature) {
      log('error', 'Invalid webhook signature', {});
      return res.status(401).send('Unauthorized');
    }
  }

  res.status(200).send('OK'); // Respond immediately to QBO

  try {
    const data = JSON.parse(payload.toString());
    const notifications = data.eventNotifications || [];

    for (const notification of notifications) {
      const realmId = notification.realmId;
      const companyEntry = getCompanyByRealmId(realmId);
      if (!companyEntry) {
        log('warning', `Received webhook for unknown realmId: ${realmId}`, { realmId });
        continue;
      }

      const [companyKey] = companyEntry;
      const entities = notification.dataChangeEvent?.entities || [];

      for (const entity of entities) {
        const isCreateOrUpdate = entity.operation === 'Create' || entity.operation === 'Update';

        // Invoices from Company 2 or 3 ONLY → deduct from master inventory (QBO + app tracker)
        // ProClean (company1) invoices → only update app tracker, QBO handles natively
        if (entity.name === 'Invoice' && isCreateOrUpdate) {
          const alreadyDone = await isAlreadyProcessed(companyKey, 'Invoice', entity.id);
          if (alreadyDone) {
            log('info', `Invoice ${entity.id} from ${companyKey} already processed, skipping`, {});
            continue;
          }
          if (companyKey !== 'company1') {
            await processInvoiceSync(companyKey, entity.id);
          } else {
            await processInvoiceSyncAppOnly(entity.id);
          }
          await markAsProcessed(companyKey, 'Invoice', entity.id);
        }

        // Bills from Company 1 → only update app tracker (QBO handles inventory natively)
        if (entity.name === 'Bill' && isCreateOrUpdate && companyKey === 'company1') {
          const alreadyDone = await isAlreadyProcessed(companyKey, 'Bill', entity.id);
          if (alreadyDone) {
            log('info', `Bill ${entity.id} already processed, skipping`, {});
            continue;
          }
          await processBillAppOnly(entity.id);
          await markAsProcessed(companyKey, 'Bill', entity.id);
        }
      }
    }
  } catch (err) {
    log('error', `Webhook processing error: ${err.message}`, { error: err.message });
  }
});

// ─── OAUTH ROUTES ─────────────────────────────────────────────────────────────
app.get('/connect/:companyKey', (req, res) => {
  const { companyKey } = req.params;
  const state = `${companyKey}_${crypto.randomBytes(8).toString('hex')}`;

  // Store state temporarily
  if (!appData.pendingStates) appData.pendingStates = {};
  appData.pendingStates[state] = { companyKey, created: Date.now() };
  saveData(appData);

  const params = new URLSearchParams({
    client_id: CONFIG.clientId,
    response_type: 'code',
    scope: SCOPES,
    redirect_uri: CONFIG.redirectUri,
    state
  });

  res.redirect(`${AUTH_BASE}?${params}`);
});

app.get('/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query;

  if (error) {
    log('error', `OAuth error: ${error}`, { error });
    return res.redirect('/?error=' + encodeURIComponent(error));
  }

  const pending = appData.pendingStates?.[state];
  if (!pending) {
    return res.redirect('/?error=invalid_state');
  }

  const { companyKey } = pending;
  delete appData.pendingStates[state];

  try {
    const creds = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: CONFIG.redirectUri
      })
    });

    const tokens = await tokenRes.json();
    if (!tokens.access_token) throw new Error('No access token received');

    if (!appData.companies[companyKey]) appData.companies[companyKey] = {};
    appData.companies[companyKey].realmId = realmId;
    appData.companies[companyKey].tokens = { ...tokens, obtained_at: Date.now() };
    appData.companies[companyKey].name = CONFIG.companies[companyKey]?.name || companyKey;
    appData.companies[companyKey].connectedAt = new Date().toISOString();

    saveData(appData);
    log('success', `${companyKey} connected successfully (realmId: ${realmId})`, { companyKey, realmId });
    res.redirect('/?connected=' + companyKey);
  } catch (err) {
    log('error', `OAuth callback failed: ${err.message}`, { error: err.message });
    res.redirect('/?error=' + encodeURIComponent(err.message));
  }
});

// ─── API ROUTES (for dashboard) ──────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  const companies = {};
  ['company1', 'company2', 'company3'].forEach(key => {
    const c = appData.companies[key] || {};
    const obtainedAt = c.tokens?.obtained_at || 0;
    const refreshExpiresAt = obtainedAt + (100 * 24 * 60 * 60 * 1000); // 100 days
    const daysUntilExpiry = Math.floor((refreshExpiresAt - Date.now()) / (1000 * 60 * 60 * 24));
    companies[key] = {
      name: c.name || CONFIG.companies[key]?.name || key,
      connected: !!c.tokens,
      realmId: c.realmId,
      connectedAt: c.connectedAt,
      isMaster: key === 'company1',
      tokenExpiresInDays: c.tokens ? daysUntilExpiry : null,
      tokenWarning: c.tokens && daysUntilExpiry <= 14 ? true : false
    };
  });

  res.json({
    companies,
    stats: appData.stats || { totalSynced: 0, errors: 0, lastSync: null },
    webhookUrl: `${process.env.APP_URL || 'https://your-app.railway.app'}/webhook`
  });
});

app.get('/api/logs', async (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const logs = await getLogs(limit);
  res.json(logs);
});

app.post('/api/test-sync', async (req, res) => {
  const { companyKey, invoiceId } = req.body;

  try {
    if (invoiceId) {
      if (companyKey === 'company1') {
        return res.status(400).json({ error: 'ProClean invoices are handled by QBO natively' });
      }
      const results = await processInvoiceSync(companyKey, invoiceId);
      res.json({ success: true, results });
    } else {
      res.status(400).json({ error: 'Provide invoiceId' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── APP INVENTORY API ────────────────────────────────────────────────────────


app.get('/api/export-csv', async (req, res) => {
  try {
    const since = req.query.since || '2026-05-12';
    const sinceDate = new Date(since + 'T00:00:00Z').toISOString();

    const rows = [];

    // Fetch invoices from all 3 companies
    for (const companyKey of ['company1', 'company2', 'company3']) {
      const company = appData.companies[companyKey];
      if (!company?.tokens) continue;
      const companyName = company.name || companyKey;

      try {
        const encoded = encodeURIComponent(`SELECT * FROM Invoice WHERE TxnDate >= '${since}' MAXRESULTS 200`);
        const data = await qboGet(companyKey, `query?query=${encoded}`);
        const invoices = data.QueryResponse?.Invoice || [];

        for (const inv of invoices) {
          const lineItems = inv.Line?.filter(l => l.DetailType === 'SalesItemLineDetail') || [];
          for (const line of lineItems) {
            const detail = line.SalesItemLineDetail;
            const itemName = detail?.ItemRef?.name;
            if (!itemName) continue;
            const qty = detail.Qty || 0;
            rows.push({
              date: inv.TxnDate,
              type: 'Invoice',
              number: inv.DocNumber || inv.Id,
              company: companyName,
              item: itemName,
              qty_out: qty,
              qty_in: '',
            });
          }
        }
      } catch (err) {
        console.error(`Error fetching invoices for ${companyKey}:`, err.message);
      }
    }

    // Fetch bills from ProClean only
    try {
      const company1 = appData.companies['company1'];
      if (company1?.tokens) {
        const encoded = encodeURIComponent(`SELECT * FROM Bill WHERE TxnDate >= '${since}' MAXRESULTS 200`);
        const data = await qboGet('company1', `query?query=${encoded}`);
        const bills = data.QueryResponse?.Bill || [];

        for (const bill of bills) {
          const lineItems = bill.Line?.filter(l => l.DetailType === 'ItemBasedExpenseLineDetail') || [];
          for (const line of lineItems) {
            const detail = line.ItemBasedExpenseLineDetail;
            const itemName = detail?.ItemRef?.name;
            if (!itemName) continue;
            const qty = detail.Qty || 0;
            rows.push({
              date: bill.TxnDate,
              type: 'Bill',
              number: bill.DocNumber || bill.Id,
              company: company1.name || 'ProClean',
              item: itemName,
              qty_out: '',
              qty_in: qty,
            });
          }
        }
      }
    } catch (err) {
      console.error('Error fetching bills:', err.message);
    }

    // Sort by date
    rows.sort((a, b) => a.date.localeCompare(b.date));

    // Build CSV
    const header = 'Date,Type,Number,Company,Item,Qty Out (Sold),Qty In (Restocked)\n';
    const csv = header + rows.map(r =>
      `${r.date},${r.type},${r.number},"${r.company}","${r.item}",${r.qty_out},${r.qty_in}`
    ).join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="inventory-movement-since-${since}.csv"`);
    res.send(csv);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


app.get('/eula', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>EULA - Inventory Sync</title>
  <style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}</style></head>
  <body><h1>End-User License Agreement</h1><p><strong>Last updated: March 2026</strong></p>
  <p>This End-User License Agreement ("Agreement") is between your company ("User") and the operator of this Inventory Sync application ("App").</p>
  <h2>1. License</h2><p>This App is licensed for internal business use only. You may not redistribute, resell, or sublicense the App.</p>
  <h2>2. Use of QuickBooks Data</h2><p>This App connects to QuickBooks Online via the Intuit API solely to read invoice and purchase order data and update inventory quantities across your connected companies.</p>
  <h2>3. Data Storage</h2><p>OAuth tokens and sync logs are stored securely in a private database. No financial data is stored beyond what is necessary for inventory sync operations.</p>
  <h2>4. Limitation of Liability</h2><p>This App is provided "as is". The operator is not liable for any inventory discrepancies, data loss, or business damages arising from use of this App.</p>
  <h2>5. Termination</h2><p>You may disconnect your QuickBooks companies at any time via the App dashboard.</p>
  <p>By using this App, you agree to these terms.</p></body></html>`);
});

app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html><html><head><title>Privacy Policy - Inventory Sync</title>
  <style>body{font-family:sans-serif;max-width:800px;margin:40px auto;padding:0 20px;line-height:1.6;color:#333}</style></head>
  <body><h1>Privacy Policy</h1><p><strong>Last updated: March 2026</strong></p>
  <p>This Privacy Policy describes how the Inventory Sync App handles your data.</p>
  <h2>1. Data We Collect</h2><p>We collect and store OAuth access tokens required to connect to your QuickBooks Online companies. We also store sync activity logs including item names, quantities, and timestamps.</p>
  <h2>2. How We Use Your Data</h2><p>Your data is used solely to sync inventory quantities across your connected QuickBooks companies. We do not sell, share, or use your data for any other purpose.</p>
  <h2>3. Data Security</h2><p>All data is stored in a secure private database. OAuth tokens are encrypted in transit via HTTPS.</p>
  <h2>4. Third Parties</h2><p>This App uses the Intuit QuickBooks API. Your use of QuickBooks is subject to Intuit's own privacy policy at intuit.com.</p>
  <h2>5. Data Deletion</h2><p>You can remove all stored data by disconnecting your companies via the App dashboard. Contact your system administrator for full data deletion.</p>
  <h2>6. Contact</h2><p>For privacy questions, contact your internal IT or system administrator.</p></body></html>`);
});

app.get('/api/diagnose/:companyKey', async (req, res) => {
  const { companyKey } = req.params;
  try {
    // List recent invoices
    const encoded = encodeURIComponent('SELECT * FROM Invoice ORDERBY MetaData.CreateTime DESC MAXRESULTS 5');
    const data = await qboGet(companyKey, `query?query=${encoded}`);
    const invoices = data.QueryResponse?.Invoice || [];
    res.json({
      companyKey,
      realmId: appData.companies[companyKey]?.realmId,
      invoiceCount: invoices.length,
      invoices: invoices.map(i => ({ id: i.Id, docNumber: i.DocNumber, total: i.TotalAmt, date: i.TxnDate })),
      rawFault: data.Fault || null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/disconnect/:companyKey', (req, res) => {
  const { companyKey } = req.params;
  if (appData.companies[companyKey]) {
    delete appData.companies[companyKey].tokens;
    delete appData.companies[companyKey].realmId;
    delete appData.companies[companyKey].connectedAt;
    saveData(appData);
    log('info', `${companyKey} disconnected`, { companyKey });
  }
  res.json({ success: true });
});

// ─── PROCLEAN INVENTORY TRACKING ─────────────────────────────────────────────

async function pcUpsertItem(item) {
  await pool.query(`
    INSERT INTO proclean_items (qbo_id, sync_token, name, sku, uom, qty_on_hand, unit_price, purchase_cost, description, item_type, last_synced, last_updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),'qbo')
    ON CONFLICT (qbo_id) DO UPDATE SET
      sync_token = $2, name = $3, sku = $4, uom = $5,
      qty_on_hand = $6, unit_price = $7, purchase_cost = $8, description = $9, item_type = $10, last_synced = NOW(), last_updated_by = 'qbo'
  `, [item.Id, item.SyncToken, item.Name, item.Sku||'', item.UnitOfMeasureSetRef?.value||'EACH', item.QtyOnHand||0, item.UnitPrice||0, item.PurchaseCost||0, item.Description||null, item.Type]);
}

async function pcLogMovement(qboId, itemName, quantity, movementType, source, note) {
  await pool.query(
    'INSERT INTO proclean_movements (qbo_id, item_name, quantity, movement_type, source, note) VALUES ($1,$2,$3,$4,$5,$6)',
    [qboId, itemName, quantity, movementType, source||null, note||null]
  );
}

async function syncProCleanItemsFromQBO() {
  if (!appData.companies['company1']?.tokens) return;
  try {
    let startPos = 1;
    const seenIds = [];
    while (true) {
      const encoded = encodeURIComponent('SELECT * FROM Item WHERE Type = \'Inventory\' STARTPOSITION ' + startPos + ' MAXRESULTS 100');
      const data = await qboGet('company1', 'query?query=' + encoded);
      const items = data.QueryResponse?.Item || [];
      if (items.length === 0) break;
      for (const item of items) {
        await pcUpsertItem(item);
        seenIds.push(item.Id);
      }
      if (items.length < 100) break;
      startPos += 100;
    }
    // Remove any items in our DB that no longer exist in QBO
    if (seenIds.length > 0) {
      const placeholders = seenIds.map((_, i) => '$' + (i + 1)).join(',');
      const deleted = await pool.query(
        'DELETE FROM proclean_items WHERE qbo_id NOT IN (' + placeholders + ') RETURNING name',
        seenIds
      );
      if (deleted.rows.length > 0) {
        console.log('[ProClean] Removed ' + deleted.rows.length + ' deleted QBO items: ' + deleted.rows.map(r => r.name).join(', '));
      }
    }
    console.log('[ProClean] QBO sync complete — ' + seenIds.length + ' items');
  } catch (err) {
    console.error('[ProClean Sync] Poll error:', err.message);
  }
}

function startProCleanPoller() {
  setTimeout(() => {
    syncProCleanItemsFromQBO();
    setInterval(syncProCleanItemsFromQBO, 5 * 60 * 1000);
  }, 10000);
}

// GET all items
app.get('/api/proclean/items', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proclean_items ORDER BY name ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET single item
app.get('/api/proclean/items/:qboId', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [req.params.qboId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Item not found' });
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET movements for item
app.get('/api/proclean/items/:qboId/movements', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM proclean_movements WHERE qbo_id = $1 ORDER BY created_at DESC LIMIT 50',
      [req.params.qboId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET recent movements
app.get('/api/proclean/movements/recent', async (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  try {
    const result = await pool.query('SELECT * FROM proclean_movements ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET stats
app.get('/api/proclean/stats', async (req, res) => {
  try {
    const result = await pool.query("SELECT qty_on_hand, unit_price, purchase_cost FROM proclean_items WHERE item_type = 'Inventory'");
    const total = result.rows.length;
    const out = result.rows.filter(r => parseFloat(r.qty_on_hand) === 0).length;
    const negative = result.rows.filter(r => parseFloat(r.qty_on_hand) < 0).length;
    const ok = total - out - negative;
    const totalValue = result.rows.reduce((sum, r) => sum + (parseFloat(r.qty_on_hand) * parseFloat(r.unit_price)), 0);
    const totalCostValue = result.rows.reduce((sum, r) => sum + (parseFloat(r.qty_on_hand) * parseFloat(r.purchase_cost)), 0);
    res.json({ total, ok, out_of_stock: out, negative, total_value: totalValue, total_cost_value: totalCostValue });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET check which companies have an item by name (pre-save check)
app.get('/api/proclean/items/:qboId/name-check', async (req, res) => {
  const { name } = req.query;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const matches = [];
    for (const companyKey of ['company2', 'company3']) {
      const company = appData.companies[companyKey];
      if (!company?.tokens) continue;
      try {
        const encoded = encodeURIComponent(`SELECT * FROM Item WHERE Name = '${name.replace(/'/g, "\'")}'`);
        const result = await qboGet(companyKey, `query?query=${encoded}`);
        const found = result.QueryResponse?.Item?.length > 0;
        matches.push({ company: company.name || companyKey, found });
      } catch(err) {
        matches.push({ company: company.name || companyKey, found: false, error: err.message });
      }
    }
    res.json({ matches });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH item (qty, name, uom) → writes to QBO (name update checks all 3 companies)
app.patch('/api/proclean/items/:qboId', async (req, res) => {
  const { qty_on_hand, name, uom, note, description } = req.body;
  try {
    const dbResult = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [req.params.qboId]);
    if (!dbResult.rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = dbResult.rows[0];

    const newQty = qty_on_hand !== undefined ? qty_on_hand : parseFloat(item.qty_on_hand);
    const qboResult = await updateInventory(item.qbo_id, newQty, item.sync_token, 'company1');
    if (qboResult.Fault) return res.status(400).json({ error: JSON.stringify(qboResult.Fault) });

    const updatedItem = qboResult.Item;
    const updatedName = name !== undefined ? name : item.name;
    const updatedUom = uom !== undefined ? uom : item.uom;

    // If name changed, update ProClean name in QBO and check Linen Pros + Brown Eyed Girl
    const nameChanged = name !== undefined && name !== item.name;
    const descChanged = description !== undefined && description !== item.description;
    if (nameChanged || descChanged) {
      // Update name and description in ProClean QBO
      const company1 = appData.companies['company1'];
      const token1 = await getAccessToken('company1');
      const qboItemData = await qboGet('company1', 'item/' + item.qbo_id);
      if (qboItemData.Item) {
        const updateBody = { ...qboItemData.Item, Name: updatedName, SyncToken: qboItemData.Item.SyncToken };
        if (description !== undefined) updateBody.Description = description;
        await fetch(`${QBO_BASE}/${company1.realmId}/item`, {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token1, 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(updateBody)
        });
      }

      // Check and update Linen Pros (company2) and Brown Eyed Girl (company3)
      const nameUpdates = [];
      for (const companyKey of ['company2', 'company3']) {
        const company = appData.companies[companyKey];
        if (!company?.tokens) continue;
        try {
          // Search for item by current name in this company
          const encoded = encodeURIComponent(`SELECT * FROM Item WHERE Name = '${item.name.replace(/'/g, "\'")}'`);
          const searchResult = await qboGet(companyKey, `query?query=${encoded}`);
          const foundItem = searchResult.QueryResponse?.Item?.[0];
          if (!foundItem) {
            nameUpdates.push({ company: company.name, found: false });
            continue;
          }
          // Update name and description in this company
          const token = await getAccessToken(companyKey);
          const updateBody = { ...foundItem, Name: updatedName, SyncToken: foundItem.SyncToken };
          if (description !== undefined) updateBody.Description = description;
          const updateRes = await fetch(`${QBO_BASE}/${company.realmId}/item`, {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(updateBody)
          });
          const updateData = await updateRes.json();
          if (updateData.Item) {
            nameUpdates.push({ company: company.name, found: true, updated: true });
          } else {
            nameUpdates.push({ company: company.name, found: true, updated: false, error: JSON.stringify(updateData.Fault) });
          }
        } catch (err) {
          nameUpdates.push({ company: company.name, found: false, error: err.message });
        }
      }
      console.log('[Name Update] Results:', JSON.stringify(nameUpdates));
    }

    const updatedDesc = description !== undefined ? description : item.description;
    await pool.query(
      'UPDATE proclean_items SET qty_on_hand=$1, sync_token=$2, name=$3, uom=$4, description=$5, last_synced=NOW(), last_updated_by=$6 WHERE qbo_id=$7',
      [updatedItem.QtyOnHand, updatedItem.SyncToken, updatedName, updatedUom, updatedDesc, 'website', item.qbo_id]
    );

    if (qty_on_hand !== undefined && parseFloat(qty_on_hand) !== parseFloat(item.qty_on_hand)) {
      const delta = parseFloat(qty_on_hand) - parseFloat(item.qty_on_hand);
      await pcLogMovement(item.qbo_id, item.name, Math.abs(delta), delta > 0 ? 'restock' : 'deduction', 'website_edit', note || 'Manual inventory edit');
    }

    const fresh = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [item.qbo_id]);
    res.json(fresh.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST log movement → writes to QBO
app.post('/api/proclean/items/:qboId/movements', async (req, res) => {
  const { quantity, movement_type, note } = req.body;
  if (!quantity || !movement_type) return res.status(400).json({ error: 'quantity and movement_type required' });
  try {
    const dbResult = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [req.params.qboId]);
    if (!dbResult.rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = dbResult.rows[0];

    const currentQty = parseFloat(item.qty_on_hand);
    const newQty = movement_type === 'deduction' ? currentQty - parseFloat(quantity) : currentQty + parseFloat(quantity);

    const qboResult = await updateInventory(item.qbo_id, newQty, item.sync_token, 'company1');
    if (qboResult.Fault) return res.status(400).json({ error: JSON.stringify(qboResult.Fault) });

    const updatedItem = qboResult.Item;
    await pool.query(
      'UPDATE proclean_items SET qty_on_hand=$1, sync_token=$2, last_synced=NOW(), last_updated_by=$3 WHERE qbo_id=$4',
      [updatedItem.QtyOnHand, updatedItem.SyncToken, 'website', item.qbo_id]
    );

    await pcLogMovement(item.qbo_id, item.name, parseFloat(quantity), movement_type, 'website', note || null);
    const movement = await pool.query('SELECT * FROM proclean_movements WHERE qbo_id = $1 ORDER BY created_at DESC LIMIT 1', [item.qbo_id]);
    res.json(movement.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH sale price → writes to QBO
app.patch('/api/proclean/items/:qboId/price', async (req, res) => {
  const { unit_price } = req.body;
  if (unit_price === undefined || isNaN(parseFloat(unit_price))) return res.status(400).json({ error: 'unit_price required' });
  try {
    const dbResult = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [req.params.qboId]);
    if (!dbResult.rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = dbResult.rows[0];

    // Fetch full item from QBO to get all required fields for update
    const qboData = await qboGet('company1', 'item/' + item.qbo_id);
    if (!qboData.Item) return res.status(400).json({ error: 'Could not fetch item from QBO' });
    const qboItem = qboData.Item;

    // POST full item back with updated price
    const company = appData.companies['company1'];
    const token = await getAccessToken('company1');
    const url = `${QBO_BASE}/${company.realmId}/item`;
    const body = { ...qboItem, UnitPrice: parseFloat(unit_price), SyncToken: qboItem.SyncToken };
    const res2 = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res2.json();
    if (result.Fault) return res.status(400).json({ error: JSON.stringify(result.Fault) });

    // Update DB
    await pool.query(
      'UPDATE proclean_items SET unit_price=$1, sync_token=$2, last_synced=NOW(), last_updated_by=$3 WHERE qbo_id=$4',
      [parseFloat(unit_price), result.Item.SyncToken, 'website', item.qbo_id]
    );

    const fresh = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [item.qbo_id]);
    res.json(fresh.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH cost price → writes to QBO
app.patch('/api/proclean/items/:qboId/cost', async (req, res) => {
  const { purchase_cost } = req.body;
  if (purchase_cost === undefined || isNaN(parseFloat(purchase_cost))) return res.status(400).json({ error: 'purchase_cost required' });
  try {
    const dbResult = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [req.params.qboId]);
    if (!dbResult.rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = dbResult.rows[0];

    const qboData = await qboGet('company1', 'item/' + item.qbo_id);
    if (!qboData.Item) return res.status(400).json({ error: 'Could not fetch item from QBO' });
    const qboItem = qboData.Item;

    const company = appData.companies['company1'];
    const token = await getAccessToken('company1');
    const url = `${QBO_BASE}/${company.realmId}/item`;
    const body = { ...qboItem, PurchaseCost: parseFloat(purchase_cost), SyncToken: qboItem.SyncToken };
    const res2 = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(body)
    });
    const result = await res2.json();
    if (result.Fault) return res.status(400).json({ error: JSON.stringify(result.Fault) });

    await pool.query(
      'UPDATE proclean_items SET purchase_cost=$1, sync_token=$2, last_synced=NOW(), last_updated_by=$3 WHERE qbo_id=$4',
      [parseFloat(purchase_cost), result.Item.SyncToken, 'website', item.qbo_id]
    );

    const fresh = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [item.qbo_id]);
    res.json(fresh.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST make item inactive in QBO → removes from website
app.post('/api/proclean/items/:qboId/deactivate', async (req, res) => {
  try {
    const dbResult = await pool.query('SELECT * FROM proclean_items WHERE qbo_id = $1', [req.params.qboId]);
    if (!dbResult.rows.length) return res.status(404).json({ error: 'Item not found' });
    const item = dbResult.rows[0];

    // Fetch full item from QBO
    const qboData = await qboGet('company1', 'item/' + item.qbo_id);
    if (!qboData.Item) return res.status(400).json({ error: 'Could not fetch item from QBO' });
    const qboItem = qboData.Item;

    const company = appData.companies['company1'];
    const token = await getAccessToken('company1');
    const url = `${QBO_BASE}/${company.realmId}/item`;
    const result = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ ...qboItem, Active: false, SyncToken: qboItem.SyncToken })
    });
    const data = await result.json();
    if (data.Fault) return res.status(400).json({ error: JSON.stringify(data.Fault) });

    // Remove from our DB
    await pool.query('DELETE FROM proclean_items WHERE qbo_id = $1', [item.qbo_id]);
    res.json({ success: true, name: item.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET export ProClean inventory as Excel (CSV for simplicity, opens in Excel)
app.get('/api/proclean/export', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT name, sku, uom, qty_on_hand, unit_price, purchase_cost,
             (qty_on_hand * unit_price) as sale_value,
             (qty_on_hand * purchase_cost) as cost_value,
             last_synced, last_updated_by
      FROM proclean_items
      WHERE item_type = 'Inventory'
      ORDER BY name ASC
    `);

    const header = 'Item Name,SKU,UOM,Qty On Hand,Sale Price,Cost Price,Sale Value,Cost Value,Last Synced,Last Updated By\n';
    const rows = result.rows.map(r => [
      `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${(r.sku||'').replace(/"/g,'""')}"`,
      r.uom || '',
      r.qty_on_hand || 0,
      parseFloat(r.unit_price || 0).toFixed(2),
      parseFloat(r.purchase_cost || 0).toFixed(2),
      parseFloat(r.sale_value || 0).toFixed(2),
      parseFloat(r.cost_value || 0).toFixed(2),
      r.last_synced ? new Date(r.last_synced).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '',
      r.last_updated_by || ''
    ].join(',')).join('\n');

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="ProClean_Inventory_${date}.csv"`);
    res.send(header + rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET export Production (Pakistan) inventory as Excel - no prices
app.get('/api/proclean/export-production', async (req, res) => {
  const PRODUCTION_SKUS = [
    '10BT','12OZWC','1414B','1414BL','1414R','1426B','16OZWC','1818H','1818PW',
    '2.75HT','4.5BT','5.5BT','5BATHMAT','5BT','6BT','7BATHMAT','8BT',
    'BGRADEBM','BIBS-BLUE','BIBS-WHT','BLKT2.5','BMT30','BMT28',
    'KNITFIT15','KNITFIT19','KNITFIT24',
    'PLT12121HM','PLT16273','PLT20307','PLT2450105',
    'T130PC','T13066104','T180108110','T180608012','T18066104','T180788012','T18081110','T18090110','T180PC',
    'T200108110','T200548012','T200608012','T200788012','T20081110','T20090110','T200PC',
    'PR10.5BT','PR10BT','PR1WC','PR3HT','PR5.5BT','PR6BT','PR.75WC','PR7BATHMAT','PR8BT'
  ];
  try {
    const result = await pool.query(`
      SELECT name, sku, qty_on_hand, last_synced
      FROM proclean_items
      WHERE item_type = 'Inventory'
      ORDER BY name ASC
    `);

    const items = result.rows.filter(r =>
      PRODUCTION_SKUS.includes((r.name||'').toUpperCase()) ||
      PRODUCTION_SKUS.includes((r.sku||'').toUpperCase())
    );

    const header = 'Item Name,SKU,Qty On Hand,Last Synced\n';
    const rows = items.map(r => [
      `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${(r.sku||'').replace(/"/g,'""')}"`,
      r.qty_on_hand || 0,
      r.last_synced ? new Date(r.last_synced).toLocaleString('en-US', { timeZone: 'America/New_York' }) : '',
    ].join(',')).join('\n');

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="Production_Inventory_${date}.csv"`);
    res.send(header + rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET monthly summary for production dashboard
app.get('/api/proclean/monthly-summary', async (req, res) => {
  const PRODUCTION_SKUS = [
    '10BT','12OZWC','1414B','1414BL','1414R','1426B','16OZWC','1818H','1818PW',
    '2.75HT','4.5BT','5.5BT','5BATHMAT','5BT','6BT','7BATHMAT','8BT',
    'BGRADEBM','BIBS-BLUE','BIBS-WHT','BLKT2.5','BMT30','BMT28',
    'KNITFIT15','KNITFIT19','KNITFIT24',
    'PLT12121HM','PLT16273','PLT20307','PLT2450105',
    'T130PC','T13066104','T180108110','T180608012','T18066104','T180788012','T18081110','T18090110','T180PC',
    'T200108110','T200548012','T200608012','T200788012','T20081110','T20090110','T200PC',
    'PR10.5BT','PR10BT','PR1WC','PR3HT','PR5.5BT','PR6BT','PR.75WC','PR7BATHMAT','PR8BT'
  ];
  try {
    // Get all production items
    const itemsRes = await pool.query(`SELECT qbo_id, name, sku FROM proclean_items WHERE item_type = 'Inventory'`);
    const prodItems = itemsRes.rows.filter(r =>
      PRODUCTION_SKUS.includes((r.name||'').toUpperCase()) ||
      PRODUCTION_SKUS.includes((r.sku||'').toUpperCase())
    );
    const prodIds = prodItems.map(i => i.qbo_id);

    if (!prodIds.length) return res.json([]);

    // Get all movements for production items grouped by month
    const movRes = await pool.query(`
      SELECT
        qbo_id, item_name,
        TO_CHAR(created_at, 'YYYY-MM') as month,
        movement_type,
        SUM(quantity) as total_qty,
        COUNT(*) as move_count
      FROM proclean_movements
      WHERE qbo_id = ANY($1)
      GROUP BY qbo_id, item_name, month, movement_type
      ORDER BY month DESC, item_name ASC
    `, [prodIds]);

    // Structure: { month: { itemName: { in, out, count } } }
    const summary = {};
    for (const row of movRes.rows) {
      if (!summary[row.month]) summary[row.month] = {};
      if (!summary[row.month][row.item_name]) summary[row.month][row.item_name] = { in: 0, out: 0, count: 0 };
      if (row.movement_type === 'restock') summary[row.month][row.item_name].in += parseFloat(row.total_qty);
      else summary[row.month][row.item_name].out += parseFloat(row.total_qty);
      summary[row.month][row.item_name].count += parseInt(row.move_count);
    }

    // Convert to array
    const result = Object.keys(summary).sort().reverse().map(month => ({
      month,
      items: Object.keys(summary[month]).sort().map(name => ({
        name,
        in: summary[month][name].in,
        out: summary[month][name].out,
        count: summary[month][name].count,
        net: summary[month][name].in - summary[month][name].out,
      }))
    }));

    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST force sync from QBO
app.post('/api/proclean/sync', async (req, res) => {
  try {
    await syncProCleanItemsFromQBO();
    const result = await pool.query('SELECT COUNT(*) FROM proclean_items');
    res.json({ success: true, itemCount: parseInt(result.rows[0].count) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve ProClean UI
app.get('/proclean', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'proclean.html'));
});

app.get('/proclean/*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'proclean.html'));
});

// ─── EMAIL NOTIFICATIONS (Resend) ────────────────────────────────────────────

async function sendResendEmail({ to, cc, subject, html }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.error('RESEND_API_KEY not set'); return false; }
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ProClean Alerts <alerts@medilinens.com>',
        to: Array.isArray(to) ? to : [to],
        cc: cc ? (Array.isArray(cc) ? cc : [cc]) : undefined,
        subject,
        html,
      })
    });
    const data = await res.json();
    if (!res.ok) { console.error('Resend error:', JSON.stringify(data)); return false; }
    console.log('[Email] Sent to', to);
    return true;
  } catch(err) {
    console.error('[Email] Error:', err.message);
    return false;
  }
}

// POST notify team member from Pakistan stock page
app.post('/api/pk/notify', async (req, res) => {
  const { recipient, note, item_name } = req.body;
  if (!recipient || !note) return res.status(400).json({ error: 'recipient and note required' });

  const recipients = {
    nihad: { email: 'nihad@procleanofatl.com', name: 'Nihad' },
    mateen: { email: 'mateen@procleanofatl.com', name: 'Abdul Mateen' },
  };

  const target = recipients[recipient];
  if (!target) return res.status(400).json({ error: 'Invalid recipient' });

  const noteHtml = (note || '').split('\n').join('<br>');
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto">
      <div style="background:#2c5282;padding:20px 24px;border-radius:8px 8px 0 0">
        <h2 style="color:white;margin:0;font-size:18px">⚠️ Urgent Inventory Message</h2>
        <p style="color:#bee3f8;margin:4px 0 0;font-size:13px">ProClean Inventory System</p>
      </div>
      <div style="background:#f7fafc;padding:24px;border:1px solid #e2e8f0;border-top:none;border-radius:0 0 8px 8px">
        <p style="margin:0 0 16px;color:#4a5568;font-size:14px">Hi ${target.name},</p>
        <p style="margin:0 0 16px;color:#4a5568;font-size:14px">You have received an urgent inventory message${item_name ? ` regarding <strong>${item_name}</strong>` : ''}:</p>
        <div style="background:white;border:1px solid #e2e8f0;border-left:4px solid #e53e3e;border-radius:4px;padding:16px;margin:0 0 16px">
          <p style="margin:0;color:#1a202c;font-size:15px;line-height:1.6">${noteHtml}</p>
        </div>
        <p style="margin:0;color:#a0aec0;font-size:12px">Sent via ProClean Inventory Tracking System · ${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })} ET</p>
      </div>
    </div>
  `;

  const ok = await sendResendEmail({
    to: target.email,
    cc: ['23alilatif@gmail.com', 'ylatif@procleanofatl.com'],
    subject: `URGENT INVENTORY MESSAGE${item_name ? ' — ' + item_name : ''}`,
    html,
  });

  if (ok) res.json({ ok: true });
  else res.status(500).json({ error: 'Failed to send email' });
});

// ─── PAKISTAN INVENTORY API ──────────────────────────────────────────────────

const PK_ITEMS = [
  { pk_name: 'BT10', proclean_name: null, uom: 'DZ' },
  { pk_name: 'WC75', proclean_name: null, uom: 'DZ' },
  { pk_name: '1414B', proclean_name: null, uom: 'BALE' },
  { pk_name: '1414BL', proclean_name: null, uom: 'BALE' },
  { pk_name: '1414R', proclean_name: null, uom: 'BALE' },
  { pk_name: '1426B', proclean_name: null, uom: 'BALE' },
  { pk_name: 'WC1', proclean_name: null, uom: 'DZ' },
  { pk_name: '1818H', proclean_name: null, uom: 'BALE' },
  { pk_name: '1818PW', proclean_name: null, uom: 'BALE' },
  { pk_name: '1616B', proclean_name: '1818HCM', uom: 'CARTON' },
  { pk_name: 'HT275', proclean_name: null, uom: 'DZ' },
  { pk_name: 'HT225', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BT45', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BT55', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BM5', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BT5', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BT6', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BM7', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BT8', proclean_name: null, uom: 'DZ' },
  { pk_name: '16WCBR', proclean_name: '1WCBROWN', uom: 'DZ' },
  { pk_name: '6BTBR', proclean_name: '6BTBROWN', uom: 'DZ' },
  { pk_name: '8BTBR', proclean_name: '8BTBROWN', uom: 'DZ' },
  { pk_name: 'BGRADEBM', proclean_name: null, uom: 'LB' },
  { pk_name: 'BIBS-BLUE', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BIBS-WHT', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BLKT2.5', proclean_name: null, uom: 'EA' },
  { pk_name: 'BMT28', proclean_name: null, uom: 'DZ' },
  { pk_name: 'BMT30', proclean_name: null, uom: 'DZ' },
  { pk_name: 'KNITFIT15', proclean_name: null, uom: 'DZ' },
  { pk_name: 'KNITFIT19', proclean_name: null, uom: 'DZ' },
  { pk_name: 'KNITFIT24', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PLT12121HM', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PLT16273', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PLT20307', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PLT2450105', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PR105', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PR1', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PR3', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PR55', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PR6', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PR75', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PR7', proclean_name: null, uom: 'DZ' },
  { pk_name: 'PR8', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T13066104', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T130PC', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T180108110', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T180608012', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T18066104', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T180548012', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T180788012', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T18081110', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T18090110', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T180PC', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T180-ZIPPER', proclean_name: 'T-180ZIPPER', uom: 'DZ' },
  { pk_name: 'T200108110', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T200548012', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T200608012', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T200788012', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T20081110', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T20090110', proclean_name: null, uom: 'DZ' },
  { pk_name: 'T200PC', proclean_name: null, uom: 'DZ' },
];

// Seed pk_inventory if empty (including initial quantities and shipments from Mateen's sheet)
async function seedPkInventory() {
  const existing = await pool.query('SELECT COUNT(*) FROM pk_inventory');

  // Migration: rename items that changed in ProClean QBO
  const renames = [
    ['12OZWC','WC75'],['16OZWC','WC1'],['2.75HT','HT275'],['5BATHMAT','BM5'],
    ['7BATHMAT','BM7'],['10BT','BT10'],['4.5BT','BT45'],['5BT','BT5'],
    ['6BT','BT6'],['8BT','BT8'],['PR1WC','PR1'],['PR.75WC','PR75'],
    ['PR3HT','PR3'],['PR5.5BT','PR55'],['PR6BT','PR6'],['PR7BATHMAT','PR7'],
    ['PR8BT','PR8'],['PR10BT','PR10'],['PR10.5BT','PR105'],['5.5BT','BT55'],
  ];
  for (const [oldName, newName] of renames) {
    try {
      await pool.query('UPDATE pk_inventory SET pk_name=$1 WHERE pk_name=$2', [newName, oldName]);
      await pool.query('UPDATE pk_shipment_items SET pk_name=$1 WHERE pk_name=$2', [newName, oldName]);
    } catch(e) {} // ignore if already renamed
  }

  // Remove PR10 if it exists (no longer carried)
  try { await pool.query("DELETE FROM pk_inventory WHERE pk_name = 'PR10'"); } catch(e) {}
  try { await pool.query("DELETE FROM pk_shipment_items WHERE pk_name = 'PR10'"); } catch(e) {}

  // Add HT225 if not exists
  await pool.query(
    "INSERT INTO pk_inventory (pk_name, proclean_name, uom, qty_in_pakistan) VALUES ('HT225', null, 'DZ', 0) ON CONFLICT DO NOTHING"
  );

  if (parseInt(existing.rows[0].count) > 0) return;

  // Seed items with initial quantities from June 2026 inventory count
  const initialQtys = {
    'WC75':5000,'1414B':0,'1414BL':10,'1414R':50,'1616B':135,'WC1':2540,
    '1818H':15,'1818PW':64,'HT275':1320,'BT45':790,'BT6':610,'BM7':150,
    'BT8':700,'BIBS-BLUE':120,'BIBS-WHT':120,'BLKT2.5':600,'BMT28':1750,
    'KNITFIT15':50,'KNITFIT19':300,'KNITFIT24':100,'PLT12121HM':800,'PLT16273':370,
    'PLT20307':130,'PLT2450105':100,'PR105':900,'PR1':17100,'PR3':800,
    'PR55':2100,'PR6':1125,'PR75':9800,'PR7':140,'PR8':875,
  };

  for (const item of PK_ITEMS) {
    await pool.query(
      'INSERT INTO pk_inventory (pk_name, proclean_name, uom, qty_in_pakistan) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [item.pk_name, item.proclean_name, item.uom, initialQtys[item.pk_name] || 0]
    );
  }

  // Seed 3 shipments from Mateen's sheet
  const shipments = [
    { name: 'TSI/286', eta: '2026-06-06' },
    { name: 'TSI/295', eta: '2026-07-06' },
    { name: 'SF/6410', eta: '2026-07-06' },
  ];

  const shipmentItems = {
    'TSI/286': { 'WC75':2000,'1414B':20,'1616B':45,'1818H':25,'1818PW':16,'BT45':200,'16WCBR':1800,'6BTBR':360,'8BTBR':160,'BIBS-BLUE':120,'BIBS-WHT':120,'KNITFIT15':200,'KNITFIT19':200,'PR105':200,'PR1':6000,'PR55':400,'PR6':400,'PR75':2000,'PR8':250,'T180PC':500 },
    'TSI/295': { 'WC75':2000,'1414B':20,'1616B':45,'1818H':20,'1818PW':16,'BT45':350,'16WCBR':900,'6BTBR':150,'8BTBR':180,'BIBS-BLUE':48,'KNITFIT15':130,'KNITFIT19':300,'PR105':200,'PR1':6000,'PR3':650,'PR55':500,'PR6':300,'PR75':2000,'PR7':100,'PR8':300,'BMT30':400,'T200PC':504 },
    'SF/6410': { 'T13066104':600,'T130PC':2500,'T180108110':30,'T180608012':30,'T18066104':1000,'T180548012':30,'T180788012':30,'T18081110':30,'T18090110':30,'T180PC':2000,'T180-ZIPPER':300,'T200548012':30,'T200608012':30,'T200788012':30,'T20081110':30,'T20090110':20 },
  };

  for (const ship of shipments) {
    const res = await pool.query(
      'INSERT INTO pk_shipments (name, eta) VALUES ($1,$2) RETURNING id',
      [ship.name, ship.eta]
    );
    const shipId = res.rows[0].id;
    const items = shipmentItems[ship.name] || {};
    for (const [pkName, qty] of Object.entries(items)) {
      if (qty > 0) {
        await pool.query(
          'INSERT INTO pk_shipment_items (shipment_id, pk_name, quantity) VALUES ($1,$2,$3) ON CONFLICT (shipment_id, pk_name) DO UPDATE SET quantity=$3',
          [shipId, pkName, qty]
        );
      }
    }
  }

  console.log('[PK] Seeded', PK_ITEMS.length, 'items and 3 shipments with initial quantities');
}

// GET full pakistan inventory view (items + shipments + ATL qty)
app.get('/api/pk/inventory', async (req, res) => {
  try {
    const [itemsRes, shipmentsRes, shipmentItemsRes, atlRes] = await Promise.all([
      pool.query('SELECT * FROM pk_inventory ORDER BY pk_name ASC'),
      pool.query('SELECT * FROM pk_shipments ORDER BY created_at ASC'),
      pool.query('SELECT * FROM pk_shipment_items'),
      pool.query("SELECT name, sku, qty_on_hand FROM proclean_items WHERE item_type = 'Inventory'"),
    ]);

    // Build ATL lookup by name and sku
    const atlMap = {};
    for (const r of atlRes.rows) {
      atlMap[r.name.toUpperCase()] = parseFloat(r.qty_on_hand) || 0;
      if (r.sku) atlMap[r.sku.toUpperCase()] = parseFloat(r.qty_on_hand) || 0;
    }

    // Build shipment items lookup: shipmentId -> pkName -> qty
    const shipItemMap = {};
    for (const si of shipmentItemsRes.rows) {
      if (!shipItemMap[si.shipment_id]) shipItemMap[si.shipment_id] = {};
      shipItemMap[si.shipment_id][si.pk_name] = parseFloat(si.quantity) || 0;
    }

    const items = itemsRes.rows.map(item => {
      const lookupName = (item.proclean_name || item.pk_name).toUpperCase();
      const atl_qty = atlMap[lookupName] ?? null;
      const shipments = shipmentsRes.rows.map(s => ({
        shipment_id: s.id,
        qty: shipItemMap[s.id]?.[item.pk_name] || 0
      }));
      const total_on_water = shipments.reduce((sum, s) => sum + s.qty, 0);
      return { ...item, atl_qty, shipments, total_on_water };
    });

    res.json({ items, shipments: shipmentsRes.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH pakistan qty for an item
app.patch('/api/pk/inventory/:pkName', async (req, res) => {
  const { qty_in_pakistan } = req.body;
  try {
    await pool.query(
      'UPDATE pk_inventory SET qty_in_pakistan=$1, last_updated=NOW() WHERE pk_name=$2',
      [parseFloat(qty_in_pakistan) || 0, req.params.pkName]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET all shipments
app.get('/api/pk/shipments', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM pk_shipments ORDER BY created_at ASC');
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST create new shipment (max 5)
app.post('/api/pk/shipments', async (req, res) => {
  const { name, eta } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const count = await pool.query('SELECT COUNT(*) FROM pk_shipments');
    if (parseInt(count.rows[0].count) >= 5) return res.status(400).json({ error: 'Maximum 5 active shipments allowed' });
    const result = await pool.query(
      'INSERT INTO pk_shipments (name, eta) VALUES ($1,$2) RETURNING *',
      [name, eta || null]
    );
    res.json(result.rows[0]);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DELETE shipment (zero out and remove)
app.delete('/api/pk/shipments/:id', async (req, res) => {
  try {
    await pool.query('DELETE FROM pk_shipments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH notes for an item
app.patch('/api/pk/inventory/:pkName/notes', async (req, res) => {
  const { notes } = req.body;
  try {
    await pool.query(
      'UPDATE pk_inventory SET notes=$1, last_updated=NOW() WHERE pk_name=$2',
      [notes || null, req.params.pkName]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH target stock for an item
app.patch('/api/pk/inventory/:pkName/target', async (req, res) => {
  const { target_stock } = req.body;
  try {
    await pool.query(
      'UPDATE pk_inventory SET target_stock=$1, last_updated=NOW() WHERE pk_name=$2',
      [target_stock !== '' && target_stock !== null ? parseFloat(target_stock) : null, req.params.pkName]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH hot status for an item
app.patch('/api/pk/inventory/:pkName/hot', async (req, res) => {
  const { is_hot } = req.body;
  try {
    await pool.query(
      'UPDATE pk_inventory SET is_hot=$1, last_updated=NOW() WHERE pk_name=$2',
      [!!is_hot, req.params.pkName]
    );
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH qty for item in a shipment
app.patch('/api/pk/shipments/:shipmentId/items/:pkName', async (req, res) => {
  const { quantity } = req.body;
  const { shipmentId, pkName } = req.params;
  try {
    await pool.query(`
      INSERT INTO pk_shipment_items (shipment_id, pk_name, quantity)
      VALUES ($1,$2,$3)
      ON CONFLICT (shipment_id, pk_name) DO UPDATE SET quantity=$3
    `, [shipmentId, pkName, parseFloat(quantity) || 0]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST zero out entire shipment (all items set to 0) then delete
app.post('/api/pk/shipments/:id/zero-out', async (req, res) => {
  try {
    await pool.query('DELETE FROM pk_shipments WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET export Pakistan inventory as CSV
app.get('/api/pk/export', async (req, res) => {
  try {
    const [itemsRes, shipmentsRes, shipmentItemsRes, atlRes] = await Promise.all([
      pool.query('SELECT * FROM pk_inventory ORDER BY pk_name ASC'),
      pool.query('SELECT * FROM pk_shipments ORDER BY created_at ASC'),
      pool.query('SELECT * FROM pk_shipment_items'),
      pool.query("SELECT name, sku, qty_on_hand FROM proclean_items WHERE item_type = 'Inventory'"),
    ]);

    const atlMap = {};
    for (const r of atlRes.rows) {
      atlMap[r.name.toUpperCase()] = parseFloat(r.qty_on_hand) || 0;
      if (r.sku) atlMap[r.sku.toUpperCase()] = parseFloat(r.qty_on_hand) || 0;
    }

    const shipItemMap = {};
    for (const si of shipmentItemsRes.rows) {
      if (!shipItemMap[si.shipment_id]) shipItemMap[si.shipment_id] = {};
      shipItemMap[si.shipment_id][si.pk_name] = parseFloat(si.quantity) || 0;
    }

    const shipHeaders = shipmentsRes.rows.map(s => `"${s.name} (ETA: ${s.eta ? new Date(s.eta).toLocaleDateString('en-US') : 'TBD'})"`).join(',');
    const header = `Item Name,ProClean Name,UOM,Qty in Pakistan,${shipHeaders},Total On Water,Atlanta (ATL) Qty,Target ATL Stock,Hot Item,Notes\n`;

    const rows = itemsRes.rows.map(item => {
      const lookupName = (item.proclean_name || item.pk_name).toUpperCase();
      const atl = atlMap[lookupName] ?? '';
      const shipQtys = shipmentsRes.rows.map(s => shipItemMap[s.id]?.[item.pk_name] || 0);
      const totalOnWater = shipQtys.reduce((a, b) => a + b, 0);
      return [
        `"${item.pk_name}"`,
        `"${item.proclean_name || ''}"`,
        item.uom,
        item.qty_in_pakistan || 0,
        ...shipQtys,
        totalOnWater,
        atl,
        item.target_stock !== null && item.target_stock !== undefined ? item.target_stock : '',
        item.is_hot ? 'YES' : '',
        `"${(item.notes || '').replace(/"/g, '""')}"`,
      ].join(',');
    }).join('\n');

    const date = new Date().toISOString().split('T')[0];
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="Pakistan_Inventory_${date}.csv"`);
    res.send(header + rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Serve Production Dashboard (read-only, Pakistan team)
app.get('/production', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'production.html'));
});

// PWA manifests
app.get('/manifest-proclean.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manifest-proclean.json'));
});
app.get('/manifest-production.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manifest-production.json'));
});

// ─── START ────────────────────────────────────────────────────────────────────
initDb()
  .then(() => loadData())
  .then(data => {
    appData = data;
    startProCleanPoller();
    seedPkInventory();
    app.listen(CONFIG.port, () => {
      console.log(`\n🚀 QBO Inventory Sync running on port ${CONFIG.port}`);
      console.log(`   Dashboard: http://localhost:${CONFIG.port}`);
      console.log(`   Webhook:   http://localhost:${CONFIG.port}/webhook\n`);
    });
  })
  .catch(err => {
    console.error('Failed to initialize database:', err);
    process.exit(1);
  });
