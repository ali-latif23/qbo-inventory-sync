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
  `);
  console.log('✅ Database initialized');
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
    company1: { name: 'Company 1 (Master Inventory)', realmId: null, tokens: null },
    company2: { name: 'Company 2', realmId: null, tokens: null },
    company3: { name: 'Company 3', realmId: null, tokens: null },
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

// Purchase Order in Company 1 → INCREASE master inventory
async function processPurchaseOrderSync(poId) {
  const sourceCompany = appData.companies['company1'];
  if (!sourceCompany) throw new Error('Company 1 (master) not connected');

  log('info', `Processing PO ${poId} from Company 1 (master)`, { poId });

  const data = await qboGet('company1', `purchaseorder/${poId}`);
  const po = data.PurchaseOrder;
  if (!po) throw new Error(`PO ${poId} not found`);

  // Only process open/pending POs, not already closed ones
  if (po.POStatus === 'Closed') {
    log('info', `PO ${poId} is already closed, skipping`, { poId });
    return [];
  }

  const lineItems = po.Line?.filter(l => l.DetailType === 'ItemBasedExpenseLineDetail') || [];
  if (lineItems.length === 0) {
    log('info', `PO ${poId} has no item line items`, {});
    return [];
  }

  const results = [];

  for (const line of lineItems) {
    const detail = line.ItemBasedExpenseLineDetail;
    const itemRef = detail?.ItemRef;
    if (!itemRef) continue;

    const qty = detail.Qty || 0;
    const itemName = itemRef.name;

    try {
      const masterItems = await queryItems('company1', itemName);

      if (masterItems.length === 0) {
        log('warning', `Item "${itemName}" not found in master inventory`, { itemName, poId });
        continue;
      }

      const masterItem = masterItems[0];
      if (masterItem.Type !== 'Inventory') {
        log('info', `Item "${itemName}" is not inventory type, skipping`, { itemName });
        continue;
      }

      const currentQty = masterItem.QtyOnHand || 0;
      const newQty = currentQty + qty;

      const updateResult = await updateInventory(masterItem.Id, newQty, masterItem.SyncToken, 'company1');

      if (updateResult.Item) {
        results.push({ itemName, added: qty, from: currentQty, to: newQty });
        log('success', `Inventory restocked: "${itemName}" ${currentQty} → ${newQty} (+${qty} from PO)`, {
          itemName, currentQty, newQty, qty, poId,
          sourceCompany: sourceCompany.name
        });
      } else {
        log('error', `Failed to restock "${itemName}"`, { updateResult, itemName });
      }
    } catch (err) {
      log('error', `Error processing PO item "${itemName}": ${err.message}`, { itemName, error: err.message });
    }
  }

  return results;
}

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
      const newQty = Math.max(0, currentQty - qty);

      const updateResult = await updateInventory(masterItem.Id, newQty, masterItem.SyncToken, 'company1');

      if (updateResult.Item) {
        results.push({ itemName, deducted: qty, from: currentQty, to: newQty });
        log('success', `Inventory updated: "${itemName}" ${currentQty} → ${newQty} (deducted ${qty})`, {
          itemName, currentQty, newQty, qty, invoiceId,
          sourceCompany: sourceCompany.name
        });
      } else {
        log('error', `Failed to update "${itemName}"`, { updateResult, itemName });
      }
    } catch (err) {
      log('error', `Error syncing item "${itemName}": ${err.message}`, { itemName, error: err.message });
    }
  }

  return results;
}

// ─── WEBHOOK ENDPOINT ─────────────────────────────────────────────────────────
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

        // Invoices from ANY company → deduct from master inventory
        if (entity.name === 'Invoice' && isCreateOrUpdate) {
          await processInvoiceSync(companyKey, entity.id);
        }

        // Purchase Orders from Company 1 ONLY → add to master inventory
        if (entity.name === 'PurchaseOrder' && isCreateOrUpdate && companyKey === 'company1') {
          await processPurchaseOrderSync(entity.id);
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
    companies[key] = {
      name: c.name || CONFIG.companies[key]?.name || key,
      connected: !!c.tokens,
      realmId: c.realmId,
      connectedAt: c.connectedAt,
      isMaster: key === 'company1'
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
  const { companyKey, invoiceId, poId, type } = req.body;

  try {
    if (type === 'po' && poId) {
      if (companyKey !== 'company1') {
        return res.status(400).json({ error: 'Purchase Orders only sync from Company 1 (master)' });
      }
      const results = await processPurchaseOrderSync(poId);
      res.json({ success: true, results });
    } else if (invoiceId) {
      const results = await processInvoiceSync(companyKey, invoiceId);
      res.json({ success: true, results });
    } else {
      res.status(400).json({ error: 'Provide invoiceId or poId with type=po' });
    }
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

// ─── START ────────────────────────────────────────────────────────────────────
initDb()
  .then(() => loadData())
  .then(data => {
    appData = data;
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
