const express = require('express');
const crypto = require('crypto');
const fetch = (...args) => import('node-fetch').then(({ default: f }) => f(...args));
const path = require('path');
const { Pool } = require('pg');

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
      item_type TEXT DEFAULT 'Inventory',
      last_synced TIMESTAMPTZ DEFAULT NOW(),
      last_updated_by TEXT DEFAULT 'qbo'
    );
    -- Add columns if table already exists (safe migration)
    ALTER TABLE proclean_items ADD COLUMN IF NOT EXISTS unit_price NUMERIC NOT NULL DEFAULT 0;
    ALTER TABLE proclean_items ADD COLUMN IF NOT EXISTS purchase_cost NUMERIC NOT NULL DEFAULT 0;
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

async function appInventorySet(itemName, sku, qty) {
  await pool.query(`
    INSERT INTO app_inventory (item_name, sku, qty_on_hand, last_updated, last_updated_by)
    VALUES ($1, $2, $3, NOW(), 'qbo_import')
    ON CONFLICT (item_name) DO UPDATE
      SET sku = $2,
          qty_on_hand = $3,
          last_updated = NOW(),
          last_updated_by = 'qbo_import'
  `, [itemName, sku || '', qty]);
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

  // Don't sync from master company (Company 1) - it IS the inventory source
  // Actually we DO want to deduct even from Company 1 invoices
  // but the inventory lives in Company 1 so it self-updates

  log('info', `Processing invoice ${invoiceId} from ${sourceCompany.name}`, { sourceCompanyKey, invoiceId });

  const invoice = await getInvoiceWithRetry(sourceCompanyKey, invoiceId);
  if (!invoice) throw new Error(`Invoice ${invoiceId} not found - may not be accessible via API yet`);
  if (invoice.status === 'Void' || invoice.PrivateNote?.includes('__synced__')) return;

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

    const qtyToDeduct = line.Amount / (detail.UnitPrice || 1);
    const qty = detail.Qty || qtyToDeduct;
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

// Initialize from QBO — fetch all inventory items and store as baseline
app.post('/api/inventory/init', async (req, res) => {
  try {
    if (!appData.companies['company1']?.tokens) {
      return res.status(400).json({ error: 'ProClean not connected' });
    }
    let startPos = 1;
    let totalFetched = 0;
    while (true) {
      const encoded = encodeURIComponent(`SELECT * FROM Item WHERE Type = 'Inventory' STARTPOSITION ${startPos} MAXRESULTS 100`);
      const data = await qboGet('company1', `query?query=${encoded}`);
      const items = data.QueryResponse?.Item || [];
      if (items.length === 0) break;
      for (const item of items) {
        await appInventorySet(item.Name, item.Sku || '', item.QtyOnHand || 0);
      }
      totalFetched += items.length;
      if (items.length < 100) break;
      startPos += 100;
    }
    res.json({ success: true, itemsImported: totalFetched });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all app inventory items
app.get('/api/inventory', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM app_inventory ORDER BY item_name ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manually edit a single item quantity
app.post('/api/inventory/edit', async (req, res) => {
  const { itemName, newQty, reason } = req.body;
  if (!itemName || newQty === undefined) return res.status(400).json({ error: 'itemName and newQty required' });
  try {
    await pool.query(`
      UPDATE app_inventory SET qty_on_hand = $1, last_updated = NOW(), last_updated_by = $2
      WHERE item_name = $3
    `, [newQty, reason || 'manual_edit', itemName]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/inventory/delete', async (req, res) => {
  const { itemName } = req.body;
  if (!itemName) return res.status(400).json({ error: 'itemName required' });
  try {
    await pool.query('DELETE FROM app_inventory WHERE item_name = $1', [itemName]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Fetch live QBO quantity for a single item (for comparison)
app.get('/api/inventory/qbo/:itemName', async (req, res) => {
  try {
    const items = await queryItems('company1', req.params.itemName);
    if (items.length === 0) return res.json({ qboQty: null });
    res.json({ qboQty: items[0].QtyOnHand });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/inventory', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>QBO Sync — Inventory Tracker</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 24px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #64748b; margin-bottom: 24px; font-size: 14px; }
    .nav { margin-bottom: 24px; }
    .nav a { color: #6366f1; text-decoration: none; font-size: 14px; }
    .top-bar { display: flex; gap: 12px; align-items: center; margin-bottom: 24px; flex-wrap: wrap; }
    input[type=text] { background: #1e2433; border: 1px solid #2d3748; border-radius: 8px; color: #e2e8f0; padding: 8px 14px; font-size: 14px; width: 260px; }
    input[type=text]::placeholder { color: #4a5568; }
    button { padding: 8px 18px; border-radius: 8px; border: none; font-size: 14px; cursor: pointer; font-weight: 600; }
    .btn-primary { background: #6366f1; color: white; }
    .btn-primary:hover { background: #4f46e5; }
    .btn-secondary { background: #1e2433; color: #94a3b8; border: 1px solid #2d3748; }
    .btn-secondary:hover { background: #2d3748; }
    .btn-danger { background: #450a0a; color: #ef4444; border: 1px solid #7f1d1d; }
    .btn-sm { padding: 4px 10px; font-size: 12px; border-radius: 6px; }
    .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat { background: #1e2433; border-radius: 12px; padding: 16px 20px; border: 1px solid #2d3748; }
    .stat-label { font-size: 12px; color: #64748b; margin-bottom: 6px; }
    .stat-value { font-size: 28px; font-weight: 700; color: #6366f1; }
    .table-wrap { background: #1e2433; border-radius: 12px; border: 1px solid #2d3748; overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 10px 16px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #2d3748; }
    td { padding: 10px 16px; font-size: 14px; border-bottom: 1px solid #1a2030; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: #252d3d; }
    .qty { font-weight: 700; }
    .qty.negative { color: #ef4444; }
    .qty.low { color: #f59e0b; }
    .qty.ok { color: #10b981; }
    .diff.positive { color: #10b981; font-size: 12px; }
    .diff.negative-diff { color: #ef4444; font-size: 12px; }
    .diff.match { color: #64748b; font-size: 12px; }
    .edit-input { background: #0f1117; border: 1px solid #6366f1; border-radius: 6px; color: #e2e8f0; padding: 4px 8px; font-size: 13px; width: 80px; }
    .ts { font-size: 11px; color: #4a5568; }
    .loading { text-align: center; padding: 40px; color: #64748b; }
    .banner { background: #1e3a5f; border: 1px solid #2d5a8e; border-radius: 10px; padding: 14px 18px; margin-bottom: 20px; font-size: 14px; color: #93c5fd; display: none; }
    .banner.show { display: block; }
  </style>
</head>
<body>
  <div class="nav"><a href="/">← Back to Dashboard</a></div>
  <h1>📦 App Inventory Tracker</h1>
  <p class="subtitle">Independent tracker — never writes to QBO</p>

  <div class="banner" id="banner"></div>

  <div class="top-bar">
    <input type="text" id="search" placeholder="Search items..." oninput="filterTable()">
    <button class="btn-primary" onclick="initFromQBO()">⬇ Initialize from QBO</button>
    <button class="btn-secondary" onclick="loadInventory()">↻ Refresh</button>
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-label">Total Items</div><div class="stat-value" id="stat-total">—</div></div>
    <div class="stat"><div class="stat-label">Negative Stock</div><div class="stat-value" style="color:#ef4444" id="stat-negative">—</div></div>
    <div class="stat"><div class="stat-label">Zero Stock</div><div class="stat-value" style="color:#f59e0b" id="stat-zero">—</div></div>
    <div class="stat"><div class="stat-label">In Stock</div><div class="stat-value" style="color:#10b981" id="stat-instock">—</div></div>
  </div>

  <div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>Item Name</th>
          <th>App Qty</th>
          <th>Last Updated</th>
          <th>Updated By</th>
          <th>Edit</th>
        </tr>
      </thead>
      <tbody id="inv-body">
        <tr><td colspan="5" class="loading">Loading inventory...</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    let allItems = [];

    async function loadInventory() {
      const res = await fetch('/api/inventory');
      allItems = await res.json();
      renderTable(allItems);
      updateStats(allItems);
    }

    function updateStats(items) {
      document.getElementById('stat-total').textContent = items.length;
      document.getElementById('stat-negative').textContent = items.filter(i => parseFloat(i.qty_on_hand) < 0).length;
      document.getElementById('stat-zero').textContent = items.filter(i => parseFloat(i.qty_on_hand) === 0).length;
      document.getElementById('stat-instock').textContent = items.filter(i => parseFloat(i.qty_on_hand) > 0).length;
    }

    function renderTable(items) {
      if (items.length === 0) {
        document.getElementById('inv-body').innerHTML = '<tr><td colspan="5" class="loading">No items yet — click "Initialize from QBO" to import</td></tr>';
        return;
      }
      document.getElementById('inv-body').innerHTML = items.map(item => {
        const qty = parseFloat(item.qty_on_hand);
        const qtyClass = qty < 0 ? 'negative' : qty === 0 ? 'low' : 'ok';
        const ts = new Date(item.last_updated).toLocaleString();
        return \`<tr>
          <td><strong>\${item.item_name}</strong>\${item.sku ? '<br><span class="ts">SKU: ' + item.sku + '</span>' : ''}</td>
          <td><span class="qty \${qtyClass}">\${qty}</span></td>
          <td class="ts">\${ts}</td>
          <td class="ts">\${item.last_updated_by}</td>
          <td>
            <input type="number" class="edit-input" id="edit-\${encodeURIComponent(item.item_name)}" value="\${qty}" step="1">
            <button class="btn-primary btn-sm" style="margin-left:6px" onclick="saveEdit('\${item.item_name.replace(/'/g, "\\\\'")}')">Save</button>
            <button class="btn-danger btn-sm" style="margin-left:4px" onclick="deleteItem('\${item.item_name.replace(/'/g, "\\\\'")}')">✕</button>
          </td>
        </tr>\`;
      }).join('');
    }

    function filterTable() {
      const q = document.getElementById('search').value.toLowerCase();
      const filtered = allItems.filter(i => i.item_name.toLowerCase().includes(q) || (i.sku || '').toLowerCase().includes(q));
      renderTable(filtered);
      updateStats(filtered);
    }

    async function saveEdit(itemName) {
      const encoded = encodeURIComponent(itemName);
      const input = document.getElementById('edit-' + encoded);
      const newQty = parseFloat(input.value);
      if (isNaN(newQty)) return;
      await fetch('/api/inventory/edit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemName, newQty, reason: 'manual_edit' })
      });
      showBanner('✅ ' + itemName + ' updated to ' + newQty);
      loadInventory();
    }

    async function deleteItem(itemName) {
      if (!confirm('Remove "' + itemName + '" from the app tracker? This will not affect QBO.')) return;
      await fetch('/api/inventory/delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemName })
      });
      showBanner('🗑 ' + itemName + ' removed from tracker');
      loadInventory();
    }

    async function initFromQBO() {
      showBanner('⏳ Importing from QBO... this may take a moment');
      const res = await fetch('/api/inventory/init', { method: 'POST' });
      const data = await res.json();
      if (data.success) {
        showBanner('✅ Imported ' + data.itemsImported + ' items from QBO');
        loadInventory();
      } else {
        showBanner('❌ Error: ' + data.error);
      }
    }

    function showBanner(msg) {
      const b = document.getElementById('banner');
      b.textContent = msg;
      b.classList.add('show');
      setTimeout(() => b.classList.remove('show'), 4000);
    }

    loadInventory();
    setInterval(loadInventory, 30000);
  </script>
</body>
</html>`);
});

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

app.get('/api/reports', async (req, res) => {
  try {
    const days = parseInt(req.query.days) || 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Summary counts per day
    const dailyRes = await pool.query(`
      SELECT 
        DATE(timestamp) as date,
        type,
        COUNT(*) as count
      FROM sync_logs 
      WHERE timestamp > $1 
      GROUP BY DATE(timestamp), type
      ORDER BY date DESC
    `, [since]);

    // Recent errors
    const errorsRes = await pool.query(`
      SELECT timestamp, message, details
      FROM sync_logs 
      WHERE type = 'error' AND timestamp > $1
      ORDER BY timestamp DESC
      LIMIT 20
    `, [since]);

    // Total counts
    const totalsRes = await pool.query(`
      SELECT type, COUNT(*) as count
      FROM sync_logs
      WHERE timestamp > $1
      GROUP BY type
    `, [since]);

    const totals = {};
    totalsRes.rows.forEach(r => totals[r.type] = parseInt(r.count));

    // Build daily summary
    const dailyMap = {};
    dailyRes.rows.forEach(r => {
      const d = r.date.toISOString().split('T')[0];
      if (!dailyMap[d]) dailyMap[d] = { date: d, success: 0, error: 0, warning: 0, info: 0 };
      dailyMap[d][r.type] = parseInt(r.count);
    });

    res.json({
      period: `Last ${days} days`,
      totals,
      daily: Object.values(dailyMap).sort((a, b) => b.date.localeCompare(a.date)),
      recentErrors: errorsRes.rows
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/reports', (req, res) => {
  res.send(`<!DOCTYPE html>
<html>
<head>
  <title>QBO Sync — Reports</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f1117; color: #e2e8f0; min-height: 100vh; padding: 24px; }
    h1 { font-size: 24px; font-weight: 700; margin-bottom: 4px; }
    .subtitle { color: #64748b; margin-bottom: 24px; font-size: 14px; }
    .nav { margin-bottom: 24px; }
    .nav a { color: #6366f1; text-decoration: none; font-size: 14px; }
    .nav a:hover { text-decoration: underline; }
    .period-btns { display: flex; gap: 8px; margin-bottom: 24px; }
    .period-btn { padding: 6px 16px; border-radius: 6px; border: 1px solid #2d3748; background: #1e2433; color: #94a3b8; cursor: pointer; font-size: 13px; }
    .period-btn.active { background: #6366f1; color: white; border-color: #6366f1; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; margin-bottom: 32px; }
    .card { background: #1e2433; border-radius: 12px; padding: 20px; border: 1px solid #2d3748; }
    .card-label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
    .card-value { font-size: 32px; font-weight: 700; }
    .card-value.success { color: #10b981; }
    .card-value.error { color: #ef4444; }
    .card-value.warning { color: #f59e0b; }
    .card-value.info { color: #6366f1; }
    .section { background: #1e2433; border-radius: 12px; border: 1px solid #2d3748; margin-bottom: 24px; overflow: hidden; }
    .section-header { padding: 16px 20px; border-bottom: 1px solid #2d3748; font-weight: 600; font-size: 15px; }
    table { width: 100%; border-collapse: collapse; }
    th { padding: 10px 20px; text-align: left; font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #2d3748; }
    td { padding: 12px 20px; font-size: 14px; border-bottom: 1px solid #1a2030; }
    tr:last-child td { border-bottom: none; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; }
    .badge.success { background: #064e3b; color: #10b981; }
    .badge.error { background: #450a0a; color: #ef4444; }
    .badge.warning { background: #451a03; color: #f59e0b; }
    .empty { padding: 32px; text-align: center; color: #64748b; font-size: 14px; }
    .error-msg { font-size: 13px; color: #94a3b8; max-width: 500px; }
    .ts { font-size: 12px; color: #64748b; }
    .loading { text-align: center; padding: 60px; color: #64748b; }
  </style>
</head>
<body>
  <div class="nav"><a href="/">← Back to Dashboard</a></div>
  <h1>📊 Sync Reports</h1>
  <p class="subtitle" id="subtitle">Loading...</p>

  <div class="period-btns">
    <button class="period-btn active" onclick="load(1)">Today</button>
    <button class="period-btn" onclick="load(7)">7 Days</button>
    <button class="period-btn" onclick="load(30)">30 Days</button>
  </div>

  <div class="cards">
    <div class="card"><div class="card-label">Successful Syncs</div><div class="card-value success" id="t-success">—</div></div>
    <div class="card"><div class="card-label">Errors</div><div class="card-value error" id="t-error">—</div></div>
    <div class="card"><div class="card-label">Warnings</div><div class="card-value warning" id="t-warning">—</div></div>
    <div class="card"><div class="card-label">Info Events</div><div class="card-value info" id="t-info">—</div></div>
  </div>

  <div class="section">
    <div class="section-header">Daily Breakdown</div>
    <div id="daily-table"><div class="loading">Loading...</div></div>
  </div>

  <div class="section">
    <div class="section-header">Recent Errors</div>
    <div id="errors-table"><div class="loading">Loading...</div></div>
  </div>

  <script>
    let activeDays = 1;
    document.querySelectorAll('.period-btn').forEach(btn => {
      btn.addEventListener('click', function() {
        document.querySelectorAll('.period-btn').forEach(b => b.classList.remove('active'));
        this.classList.add('active');
      });
    });

    async function load(days) {
      activeDays = days;
      document.getElementById('subtitle').textContent = 'Loading...';
      const res = await fetch('/api/reports?days=' + days);
      const data = await res.json();

      document.getElementById('subtitle').textContent = data.period + ' — refreshed ' + new Date().toLocaleTimeString();
      document.getElementById('t-success').textContent = data.totals.success || 0;
      document.getElementById('t-error').textContent = data.totals.error || 0;
      document.getElementById('t-warning').textContent = data.totals.warning || 0;
      document.getElementById('t-info').textContent = data.totals.info || 0;

      if (data.daily.length === 0) {
        document.getElementById('daily-table').innerHTML = '<div class="empty">No activity in this period</div>';
      } else {
        document.getElementById('daily-table').innerHTML = '<table><thead><tr><th>Date</th><th>Successful</th><th>Errors</th><th>Warnings</th></tr></thead><tbody>' +
          data.daily.map(d => '<tr><td>' + d.date + '</td><td><span class="badge success">' + (d.success||0) + '</span></td><td><span class="badge error">' + (d.error||0) + '</span></td><td><span class="badge warning">' + (d.warning||0) + '</span></td></tr>').join('') +
          '</tbody></table>';
      }

      if (data.recentErrors.length === 0) {
        document.getElementById('errors-table').innerHTML = '<div class="empty">No errors in this period ✅</div>';
      } else {
        document.getElementById('errors-table').innerHTML = '<table><thead><tr><th>Time</th><th>Error</th></tr></thead><tbody>' +
          data.recentErrors.map(e => '<tr><td class="ts">' + new Date(e.timestamp).toLocaleString() + '</td><td class="error-msg">' + e.message + '</td></tr>').join('') +
          '</tbody></table>';
      }
    }

    load(1);
    setInterval(() => load(activeDays), 30000);
  </script>
</body>
</html>`);
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
    INSERT INTO proclean_items (qbo_id, sync_token, name, sku, uom, qty_on_hand, unit_price, purchase_cost, item_type, last_synced, last_updated_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),'qbo')
    ON CONFLICT (qbo_id) DO UPDATE SET
      sync_token = $2, name = $3, sku = $4, uom = $5,
      qty_on_hand = $6, unit_price = $7, purchase_cost = $8, item_type = $9, last_synced = NOW(), last_updated_by = 'qbo'
  `, [item.Id, item.SyncToken, item.Name, item.Sku||'', item.UnitOfMeasureSetRef?.value||'EACH', item.QtyOnHand||0, item.UnitPrice||0, item.PurchaseCost||0, item.Type]);
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

// PATCH item (qty, name, uom) → writes to QBO
app.patch('/api/proclean/items/:qboId', async (req, res) => {
  const { qty_on_hand, name, uom, note } = req.body;
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

    await pool.query(
      'UPDATE proclean_items SET qty_on_hand=$1, sync_token=$2, name=$3, uom=$4, last_synced=NOW(), last_updated_by=$5 WHERE qbo_id=$6',
      [updatedItem.QtyOnHand, updatedItem.SyncToken, updatedName, updatedUom, 'website', item.qbo_id]
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

    const header = 'Item Name,SKU,UOM,Qty On Hand,Sale Price,Cost Price,Sale Value,Cost Value,Last Synced,Last Updated By
';
    const rows = result.rows.map(r => [
      `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${(r.sku||'').replace(/"/g,'""')}"`,
      r.uom || '',
      r.qty_on_hand || 0,
      parseFloat(r.unit_price || 0).toFixed(2),
      parseFloat(r.purchase_cost || 0).toFixed(2),
      parseFloat(r.sale_value || 0).toFixed(2),
      parseFloat(r.cost_value || 0).toFixed(2),
      r.last_synced ? new Date(r.last_synced).toLocaleString('en-US') : '',
      r.last_updated_by || ''
    ].join(',')).join('
');

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

    const header = 'Item Name,SKU,Qty On Hand,Last Synced
';
    const rows = items.map(r => [
      `"${(r.name||'').replace(/"/g,'""')}"`,
      `"${(r.sku||'').replace(/"/g,'""')}"`,
      r.qty_on_hand || 0,
      r.last_synced ? new Date(r.last_synced).toLocaleString('en-US') : '',
    ].join(',')).join('
');

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
