const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { promisify } = require('util');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3460;
const WEB_DIR = path.join(__dirname, '..', 'web');
const PRIVATE_DOWNLOADS = path.join(__dirname, '..', 'private-downloads');
const DB_PATH = path.join(__dirname, '..', 'data', 'downloads.db');

fs.mkdirSync(path.join(__dirname, '..', 'data'), { recursive: true });
fs.mkdirSync(PRIVATE_DOWNLOADS, { recursive: true });

const db = new sqlite3.Database(DB_PATH);
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS newsletter_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS paid_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    product TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS fulfilled_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    email TEXT,
    products TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS studio_applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_legal_name TEXT NOT NULL,
    dba TEXT,
    ein TEXT NOT NULL,
    entity_type TEXT,
    contact_name TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT,
    package_interest TEXT,
    website_url TEXT,
    monthly_revenue_band TEXT,
    services_needed TEXT,
    consent_terms INTEGER DEFAULT 0,
    consent_reporting INTEGER DEFAULT 0,
    raw_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS onboarding_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'started',
    started_ip TEXT,
    user_agent TEXT,
    application_id INTEGER,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS member_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS member_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS business_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    application_id INTEGER,
    business_name TEXT,
    plan TEXT,
    membership_status TEXT NOT NULL DEFAULT 'pending_payment',
    credit_limit_status TEXT NOT NULL DEFAULT 'approved_not_active',
    approved_limit INTEGER DEFAULT 0,
    active_limit INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS addon_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    addon_key TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    stripe_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'paid',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS verification_checks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    provider TEXT NOT NULL DEFAULT 'manual_rules_v1',
    status TEXT NOT NULL DEFAULT 'pending',
    score INTEGER DEFAULT 0,
    notes TEXT,
    ein_valid INTEGER DEFAULT 0,
    email_domain_match INTEGER DEFAULT 0,
    business_name_present INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS underwriting_decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    decision TEXT NOT NULL DEFAULT 'pending',
    approved_limit INTEGER DEFAULT 0,
    reason TEXT,
    reviewer TEXT DEFAULT 'system',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS verification_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    ein_letter_provided INTEGER DEFAULT 0,
    formation_doc_provided INTEGER DEFAULT 0,
    bank_proof_provided INTEGER DEFAULT 0,
    evidence_notes TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

const stripeSecret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

const beehiivApiKey = process.env.BEEHIIV_API_KEY;
const beehiivPublicationId = process.env.BEEHIIV_PUBLICATION_ID || '73ab0160-a8c1-47bb-a157-599a0c458abe';

const PRODUCT_MAP = {
  'Ventus Elite Builder Pack': 'elite-builder',
  'Ventus CEO Operator Pack': 'ceo-operator',
  'Ventus Automotive Expert Pack': 'automotive-expert'
};

const CHECKOUT_PRODUCTS = {
  'elite-builder': { name: 'Ventus Elite Builder Pack', amount: 7500 },
  'ceo-operator': { name: 'Ventus CEO Operator Pack', amount: 9000 },
  'automotive-expert': { name: 'Ventus Automotive Expert Pack', amount: 5000 },
  'coo-systems': { name: 'Ventus COO Systems Collection', amount: 7900 },
  'sales-strategist': { name: 'Ventus Sales Strategist Collection', amount: 7900 },
  'app-architect': { name: 'Ventus App Architect Collection', amount: 8900 },
  'content-studio': { name: 'Ventus Content Studio Collection', amount: 7900 },
  'research-engine': { name: 'Ventus Research Engine Collection', amount: 8900 },
  'developer-copilot': { name: 'Ventus Developer Copilot Collection', amount: 8900 },
  'landing-page-conversion': { name: 'Ventus Landing Page Conversion Collection', amount: 8900 },
  'ai-agent-builder': { name: 'Ventus AI Agent Builder Collection', amount: 9900 },
  'prompt-qa': { name: 'Ventus Prompt QA Collection', amount: 7900 },
  'market-intelligence': { name: 'Ventus Market Intelligence Collection', amount: 8900 },
  'no-code-automation': { name: 'Ventus No-Code Automation Collection', amount: 7900 },
  'project-manager': { name: 'Ventus Project Manager Collection', amount: 6900 },
  'executive-assistant': { name: 'Ventus Executive Assistant Collection', amount: 6900 },
  'customer-success': { name: 'Ventus Customer Success Collection', amount: 6900 },
  'recruiting-operator': { name: 'Ventus Recruiting Operator Collection', amount: 6900 },
  'closer-call-scripts': { name: 'Ventus Closer Call Scripts Collection', amount: 6900 },
  'linkedin-authority': { name: 'Ventus LinkedIn Authority Collection', amount: 6900 },
  'youtube-growth': { name: 'Ventus YouTube Growth Collection', amount: 7900 },
  'newsletter-engine': { name: 'Ventus Newsletter Engine Collection', amount: 6900 },
  'paid-ads-creative': { name: 'Ventus Paid Ads Creative Collection', amount: 7900 },
  'brand-voice': { name: 'Ventus Brand Voice Collection', amount: 5900 },
  'n8n-automation-architect': { name: 'Ventus N8N Automation Architect Collection', amount: 9900 },
  'shopify-conversion-ops': { name: 'Ventus Shopify Conversion Ops Collection', amount: 9900 },
  'hubspot-revops-architect': { name: 'Ventus HubSpot RevOps Architect Collection', amount: 10900 },
  'airtable-ops': { name: 'Ventus Airtable Ops Collection', amount: 9900 },
  'webflow-build-system': { name: 'Ventus Webflow Build System Collection', amount: 10900 },
  'stripe-revenue-ops': { name: 'Ventus Stripe Revenue Ops Collection', amount: 11900 },
  'salesforce-admin-ops-architect': { name: 'Ventus Salesforce Admin Ops Architect Collection', amount: 11900 },
  'notion-ops-system-builder': { name: 'Ventus Notion Ops System Builder Collection', amount: 9900 },
  'profit-validation-sprint': { name: 'Ventus Profit Opportunity Validation Sprint', amount: 150000 }
};

const PORTAL_ADDONS = {
  'social-posting-pack': { name: 'Social Posting Pack', amount: 30000 },
  'local-seo-boost': { name: 'Local SEO Boost', amount: 40000 },
  'landing-page-sprint': { name: 'Landing Page Sprint', amount: 50000 }
};

const MEMBERSHIP_ACTIVATION = {
  name: 'Ventus Studios Membership Activation',
  amount: 50000
};

let STRIPE_PRICE_MAP = {};
try {
  const priceMapPath = path.join(__dirname, '..', 'stripe-price-map.json');
  if (fs.existsSync(priceMapPath)) {
    STRIPE_PRICE_MAP = JSON.parse(fs.readFileSync(priceMapPath, 'utf8'));
  }
} catch (e) {
  console.warn('[stripe] could not load stripe-price-map.json');
}

app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') return next();
  return express.json()(req, res, next);
});
app.use((req, res, next) => {
  if (req.path === '/api/stripe/webhook') return next();
  return express.urlencoded({ extended: true })(req, res, next);
});
app.use(express.static(WEB_DIR));

const scryptAsync = promisify(crypto.scrypt);

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  });
  return out;
}

async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const derived = await scryptAsync(password, salt, 64);
  return { salt, hash: derived.toString('hex') };
}

async function verifyPassword(password, salt, expectedHash) {
  const derived = await scryptAsync(password, salt, 64);
  return crypto.timingSafeEqual(Buffer.from(expectedHash, 'hex'), derived);
}

function setSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `ventus_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `ventus_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

async function getAuthedUser(req) {
  const cookies = parseCookies(req);
  const sessionToken = cookies.ventus_session;
  if (!sessionToken) return null;

  const session = await dbGet(
    `SELECT ms.user_id, ms.expires_at, mu.email
     FROM member_sessions ms
     JOIN member_users mu ON mu.id = ms.user_id
     WHERE ms.token = ?`,
    [sessionToken]
  );
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  return { userId: session.user_id, email: session.email };
}

function issueToken(email, product, cb) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7 days
  db.run(
    'INSERT INTO paid_tokens (email, product, token, expires_at) VALUES (?, ?, ?, ?)',
    [email || '', product, token, expires],
    (err) => cb(err, token)
  );
}

function issueTokenAsync(email, product) {
  return new Promise((resolve, reject) => {
    issueToken(email, product, (err, token) => {
      if (err) return reject(err);
      resolve(token);
    });
  });
}

function getOrigin(req) {
  const host = req.get('host');
  const inferredOrigin = host ? `https://${host}` : null;
  return process.env.PUBLIC_BASE_URL || inferredOrigin || `${req.protocol}://${host}`;
}

function buildLineItem(product) {
  const cfg = CHECKOUT_PRODUCTS[product];
  if (!cfg) return null;

  const priceId = STRIPE_PRICE_MAP?.[product]?.priceId;
  if (priceId) return { price: priceId, quantity: 1 };

  return {
    price_data: {
      currency: 'usd',
      unit_amount: cfg.amount,
      product_data: { name: cfg.name }
    },
    quantity: 1
  };
}

const mailFrom = process.env.DOWNLOAD_EMAIL_FROM || 'automations@ventusys.com';
const smtpHost = process.env.SMTP_HOST;
const smtpPort = Number(process.env.SMTP_PORT || 587);
const smtpUser = process.env.SMTP_USER;
const smtpPass = process.env.SMTP_PASS;
const smtpSecure = String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';

const mailer = (smtpHost && smtpUser && smtpPass)
  ? nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpSecure,
      auth: { user: smtpUser, pass: smtpPass }
    })
  : null;

async function sendDownloadsEmail(to, downloads, origin) {
  if (!mailer || !to) return false;

  const rows = downloads
    .map((d) => `<li style="margin-bottom:8px;"><a href="${origin}${d.downloadUrl}">${d.product}</a></li>`)
    .join('');

  const html = `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.5;color:#111;">
      <h2>Your Ventus Collections are ready</h2>
      <p>Thanks for your purchase. Use the secure links below to download your collection${downloads.length > 1 ? 's' : ''}:</p>
      <ul>${rows}</ul>
      <p>Note: each link is one-time use and expires in 7 days.</p>
      <p>- Ventus Systems</p>
    </div>
  `;

  await mailer.sendMail({
    from: mailFrom,
    to,
    subject: 'Your Ventus download links',
    html
  });

  return true;
}

function markSessionFulfilled(sessionId, email, products) {
  return new Promise((resolve, reject) => {
    db.run(
      'INSERT OR IGNORE INTO fulfilled_sessions (session_id, email, products) VALUES (?, ?, ?)',
      [sessionId, email || '', products.join(',')],
      function done(err) {
        if (err) return reject(err);
        resolve(this.changes > 0);
      }
    );
  });
}

async function subscribeToBeehiiv(email, source = 'ventus-site') {
  if (!beehiivApiKey || !beehiivPublicationId) {
    return { ok: false, reason: 'beehiiv_not_configured' };
  }

  const resp = await fetch(`https://api.beehiiv.com/v2/publications/${beehiivPublicationId}/subscriptions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${beehiivApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email,
      reactivate_existing: true,
      send_welcome_email: true,
      utm_source: source
    })
  });

  if (resp.ok) return { ok: true };

  const text = await resp.text();
  const lower = text.toLowerCase();
  if (resp.status === 409 || lower.includes('already') || lower.includes('exists')) {
    return { ok: true, already: true };
  }

  return { ok: false, status: resp.status, error: text.slice(0, 500) };
}

// Newsletter signup -> Beehiiv + local backup
app.post('/api/newsletter-signup', async (req, res) => {
  const { email, source = 'newsletter' } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const normalized = email.trim().toLowerCase();
  const beehiiv = await subscribeToBeehiiv(normalized, source);
  if (!beehiiv.ok) {
    console.error('[beehiiv] subscribe failed', beehiiv);
    return res.status(500).json({ error: 'Could not subscribe right now' });
  }

  db.run('INSERT INTO newsletter_signups (email, source) VALUES (?, ?)', [normalized, source], () => {
    return res.json({ ok: true, provider: 'beehiiv' });
  });
});

// Free download gate: email capture + Beehiiv signup + redirect
app.post('/api/free-signup', async (req, res) => {
  const { email, source = 'kitt-sidekick' } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  const normalized = email.trim().toLowerCase();
  const beehiiv = await subscribeToBeehiiv(normalized, source);
  if (!beehiiv.ok) {
    console.error('[beehiiv] free-signup subscribe failed', beehiiv);
  }

  db.run('INSERT INTO newsletter_signups (email, source) VALUES (?, ?)', [normalized, source], (err) => {
    if (err) return res.status(500).json({ error: 'Could not save signup' });
    return res.json({ ok: true, downloadUrl: '/downloads/kitt-sidekick.zip' });
  });
});

app.get('/start-application', async (req, res) => {
  try {
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 6).toISOString();
    await dbRun(
      'INSERT INTO onboarding_sessions (token, started_ip, user_agent, expires_at) VALUES (?, ?, ?, ?)',
      [token, req.ip || '', req.get('user-agent') || '', expiresAt]
    );
    return res.redirect(302, `/apply.html?token=${token}`);
  } catch (error) {
    console.error('[onboarding] start failed', error.message);
    return res.status(500).send('Could not start application right now.');
  }
});

app.get('/api/onboarding/session/:token', async (req, res) => {
  const token = String(req.params.token || '').trim();
  if (!token) return res.status(400).json({ ok: false, error: 'Token required' });
  try {
    const session = await dbGet('SELECT * FROM onboarding_sessions WHERE token = ?', [token]);
    if (!session) return res.status(404).json({ ok: false, error: 'Session not found' });
    if (session.status === 'completed') return res.status(410).json({ ok: false, error: 'Session completed' });
    if (session.expires_at && new Date(session.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'Session expired' });
    return res.json({ ok: true, token: session.token, expiresAt: session.expires_at });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not validate session' });
  }
});

app.post('/api/studio-application', async (req, res) => {
  const payload = req.body || {};
  const required = ['businessLegalName', 'ein', 'contactName', 'email', 'password', 'onboardingToken'];
  for (const key of required) {
    if (!String(payload[key] || '').trim()) {
      return res.status(400).json({ ok: false, error: `Missing required field: ${key}` });
    }
  }

  const normalizedEmail = String(payload.email || '').trim().toLowerCase();
  if (!normalizedEmail.includes('@')) return res.status(400).json({ ok: false, error: 'Valid email required' });
  if (String(payload.password).length < 8) return res.status(400).json({ ok: false, error: 'Password must be at least 8 characters' });

  try {
    const onboarding = await dbGet('SELECT * FROM onboarding_sessions WHERE token = ?', [String(payload.onboardingToken)]);
    if (!onboarding) return res.status(404).json({ ok: false, error: 'Invalid onboarding session' });
    if (onboarding.status === 'completed') return res.status(410).json({ ok: false, error: 'Onboarding session already used' });
    if (onboarding.expires_at && new Date(onboarding.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'Onboarding session expired' });

    const servicesNeeded = Array.isArray(payload.servicesNeeded)
      ? payload.servicesNeeded.map((s) => String(s).trim()).filter(Boolean)
      : [];

    const insertApp = await dbRun(
      `INSERT INTO studio_applications (
        business_legal_name, dba, ein, entity_type, contact_name, email, phone,
        package_interest, website_url, monthly_revenue_band, services_needed,
        consent_terms, consent_reporting, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(payload.businessLegalName || '').trim(),
        String(payload.dba || '').trim(),
        String(payload.ein || '').trim(),
        String(payload.entityType || '').trim(),
        String(payload.contactName || '').trim(),
        normalizedEmail,
        String(payload.phone || '').trim(),
        String(payload.packageInterest || '').trim(),
        String(payload.websiteUrl || '').trim(),
        String(payload.monthlyRevenueBand || '').trim(),
        servicesNeeded.join(','),
        payload.consentTerms ? 1 : 0,
        payload.consentReporting ? 1 : 0,
        JSON.stringify(payload)
      ]
    );

    const applicationId = insertApp.lastID;

    let user = await dbGet('SELECT * FROM member_users WHERE email = ?', [normalizedEmail]);
    if (!user) {
      const pw = await hashPassword(String(payload.password));
      const createUser = await dbRun('INSERT INTO member_users (email, password_hash, password_salt) VALUES (?, ?, ?)', [normalizedEmail, pw.hash, pw.salt]);
      user = { id: createUser.lastID, email: normalizedEmail };
    }

    await dbRun(
      `INSERT INTO business_memberships (user_id, application_id, business_name, plan, membership_status, credit_limit_status, approved_limit, active_limit)
       VALUES (?, ?, ?, ?, 'pending_payment', 'verification_pending', 0, 0)`,
      [user.id, applicationId, String(payload.businessLegalName || '').trim(), String(payload.packageInterest || 'Foundation').trim()]
    );

    await dbRun(
      `INSERT INTO verification_checks (application_id, user_id, provider, status, score, notes)
       VALUES (?, ?, 'manual_rules_v1', 'pending', 0, 'Awaiting verification run')`,
      [applicationId, user.id]
    );

    await dbRun(
      `INSERT INTO underwriting_decisions (application_id, user_id, decision, approved_limit, reason, reviewer)
       VALUES (?, ?, 'pending', 0, 'Verification not completed', 'system')`,
      [applicationId, user.id]
    );

    await dbRun('UPDATE onboarding_sessions SET status = ?, application_id = ? WHERE token = ?', ['completed', applicationId, String(payload.onboardingToken)]);

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    await dbRun('INSERT INTO member_sessions (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, sessionToken, sessionExpires]);
    setSessionCookie(res, sessionToken);

    return res.json({ ok: true, id: applicationId, redirect: '/portal.html' });
  } catch (error) {
    console.error('[studio-application] submit failed', error.message);
    return res.status(500).json({ ok: false, error: 'Could not submit application' });
  }
});

// Paid download endpoint using issued token
app.get('/api/download/:product', (req, res) => {
  const { product } = req.params;
  const { token } = req.query;
  if (!token) return res.status(401).send('Missing token');

  db.get('SELECT * FROM paid_tokens WHERE token = ? AND product = ?', [token, product], (err, row) => {
    if (err || !row) return res.status(403).send('Invalid token');
    if (row.used_at) return res.status(403).send('Token already used');
    if (row.expires_at && new Date(row.expires_at) < new Date()) return res.status(403).send('Token expired');

    const filePath = path.join(PRIVATE_DOWNLOADS, `${product}.zip`);
    if (!fs.existsSync(filePath)) return res.status(404).send('File not found');

    db.run('UPDATE paid_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = ?', [token]);
    return res.download(filePath);
  });
});

// Create Stripe Checkout session per collection (no public direct file access)
app.get('/buy/:product', async (req, res) => {
  if (!stripe) return res.status(500).send('Stripe not configured');
  const product = req.params.product;
  const cfg = CHECKOUT_PRODUCTS[product];
  if (!cfg) return res.status(404).send('Unknown product');

  try {
    const origin = getOrigin(req);
    const lineItem = buildLineItem(product);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [lineItem],
      metadata: { products: product },
      success_url: `${origin}/paid-success.html?session_id={CHECKOUT_SESSION_ID}&product=${product}`,
      cancel_url: `${origin}/packs.html`
    });

    return res.redirect(303, session.url);
  } catch (e) {
    console.error('[stripe] checkout create failed', {
      product,
      type: e?.type,
      code: e?.code,
      message: e?.message
    });
    return res.status(500).send('Could not create checkout session');
  }
});

// Cart checkout endpoint (multi-pack)
app.post('/api/create-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });

  const rawProducts = Array.isArray(req.body?.products) ? req.body.products : [];
  const products = [...new Set(rawProducts.map((p) => String(p || '').trim()))]
    .filter((p) => p && CHECKOUT_PRODUCTS[p]);

  if (!products.length) return res.status(400).json({ error: 'No valid products' });

  try {
    const lineItems = products.map((p) => buildLineItem(p));
    const origin = getOrigin(req);

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      metadata: { products: products.join(',') },
      success_url: `${origin}/paid-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/packs.html`
    });

    return res.json({ ok: true, url: session.url });
  } catch (e) {
    console.error('[stripe] cart checkout create failed', {
      products,
      type: e?.type,
      code: e?.code,
      message: e?.message
    });
    return res.status(500).json({ error: 'Could not create checkout session' });
  }
});

// Verify checkout session and issue one-time download token(s)
app.get('/api/checkout-complete', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { session_id, product } = req.query;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.status(402).json({ error: 'Payment not completed' });

    let products = [];
    if (product) {
      const p = String(product);
      if (!CHECKOUT_PRODUCTS[p]) return res.status(400).json({ error: 'Invalid product' });
      products = [p];
    } else if (session.metadata?.products) {
      products = session.metadata.products
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p && CHECKOUT_PRODUCTS[p]);
    }

    if (!products.length) return res.status(400).json({ error: 'No products found for session' });

    const email = session.customer_details?.email || '';
    const downloads = [];

    for (const p of products) {
      const token = await issueTokenAsync(email, p);
      downloads.push({ product: p, downloadUrl: `/api/download/${p}?token=${token}` });
    }

    if (downloads.length === 1) {
      return res.json({ ok: true, product: downloads[0].product, downloadUrl: downloads[0].downloadUrl, downloads });
    }

    return res.json({ ok: true, downloads });
  } catch (e) {
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// Stripe webhook: issue download tokens + optional email delivery
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(400).send('Stripe webhook not configured');

  const signature = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.body, signature, stripeWebhookSecret);
  } catch (err) {
    console.error('[stripe] webhook signature verification failed', err?.message);
    return res.status(400).send('Invalid signature');
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const sessionId = session.id;
    const email = session.customer_details?.email || '';
    const kind = session.metadata?.kind || 'download';

    if (kind === 'membership_activation') {
      try {
        const userId = Number(session.metadata?.user_id || 0);
        if (userId) {
          await dbRun(
            `UPDATE business_memberships
             SET membership_status = 'active',
                 credit_limit_status = CASE
                   WHEN credit_limit_status = 'approved_not_active' AND approved_limit > 0 THEN 'active'
                   ELSE credit_limit_status
                 END,
                 active_limit = CASE
                   WHEN credit_limit_status = 'approved_not_active' AND approved_limit > 0 THEN approved_limit
                   ELSE active_limit
                 END
             WHERE user_id = ?`,
            [userId]
          );
        }
      } catch (err) {
        console.error('[stripe] membership activation update failed', err?.message);
      }
    } else if (kind === 'addon_purchase') {
      try {
        const userId = Number(session.metadata?.user_id || 0);
        const addonKey = String(session.metadata?.addon_key || '');
        const addonAmount = Number(session.metadata?.addon_amount || 0);
        if (userId && addonKey && addonAmount > 0) {
          await dbRun(
            `INSERT INTO addon_purchases (user_id, addon_key, amount_cents, stripe_session_id, status)
             VALUES (?, ?, ?, ?, 'paid')`,
            [userId, addonKey, addonAmount, sessionId]
          );
        }
      } catch (err) {
        console.error('[stripe] addon purchase save failed', err?.message);
      }
    } else {
      const products = (session.metadata?.products || '')
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p && CHECKOUT_PRODUCTS[p]);

      if (products.length) {
        try {
          const inserted = await markSessionFulfilled(sessionId, email, products);
          if (inserted) {
            const downloads = [];
            for (const p of products) {
              const token = await issueTokenAsync(email, p);
              downloads.push({ product: p, downloadUrl: `/api/download/${p}?token=${token}` });
            }

            const origin = process.env.PUBLIC_BASE_URL || 'https://ventusys.com';
            try {
              await sendDownloadsEmail(email, downloads, origin);
            } catch (mailErr) {
              console.error('[mail] send failed', mailErr?.message);
            }
          }
        } catch (err) {
          console.error('[stripe] webhook fulfillment failed', err?.message);
        }
      }
    }
  }

  return res.json({ received: true });
});

app.post('/api/member/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });
  try {
    const user = await dbGet('SELECT * FROM member_users WHERE email = ?', [email]);
    if (!user) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
    const valid = await verifyPassword(password, user.password_salt, user.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    await dbRun('INSERT INTO member_sessions (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, token, expiresAt]);
    setSessionCookie(res, token);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not log in' });
  }
});

app.post('/api/member/logout', async (req, res) => {
  try {
    const cookies = parseCookies(req);
    if (cookies.ventus_session) {
      await dbRun('DELETE FROM member_sessions WHERE token = ?', [cookies.ventus_session]);
    }
    clearSessionCookie(res);
    return res.json({ ok: true });
  } catch {
    clearSessionCookie(res);
    return res.json({ ok: true });
  }
});

app.get('/api/member/me', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const membership = await dbGet(
      `SELECT bm.*, sa.created_at AS application_created_at
       FROM business_memberships bm
       LEFT JOIN studio_applications sa ON sa.id = bm.application_id
       WHERE bm.user_id = ?
       ORDER BY bm.id DESC LIMIT 1`,
      [auth.userId]
    );

    const addons = await new Promise((resolve, reject) => {
      db.all('SELECT addon_key, amount_cents, created_at FROM addon_purchases WHERE user_id = ? ORDER BY id DESC LIMIT 20', [auth.userId], (err, rows) => {
        if (err) return reject(err);
        resolve(rows || []);
      });
    });

    const verification = await dbGet(
      `SELECT status, score, notes, provider, updated_at
       FROM verification_checks
       WHERE user_id = ?
       ORDER BY id DESC LIMIT 1`,
      [auth.userId]
    );

    const evidence = await dbGet(
      `SELECT ein_letter_provided, formation_doc_provided, bank_proof_provided, evidence_notes, updated_at
       FROM verification_evidence
       WHERE user_id = ?
       ORDER BY id DESC LIMIT 1`,
      [auth.userId]
    );

    const underwriting = await dbGet(
      `SELECT decision, approved_limit, reason, reviewer, updated_at
       FROM underwriting_decisions
       WHERE user_id = ?
       ORDER BY id DESC LIMIT 1`,
      [auth.userId]
    );

    return res.json({
      ok: true,
      user: { email: auth.email },
      membership: membership || null,
      addons,
      verification: verification || null,
      evidence: evidence || null,
      underwriting: underwriting || null
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not load profile' });
  }
});

app.get('/api/member/addons/catalog', async (_req, res) => {
  return res.json({ ok: true, addons: PORTAL_ADDONS });
});

app.post('/api/member/activate-membership-checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe not configured' });
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const origin = getOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: MEMBERSHIP_ACTIVATION.amount,
          product_data: { name: MEMBERSHIP_ACTIVATION.name }
        },
        quantity: 1
      }],
      metadata: {
        kind: 'membership_activation',
        user_id: String(auth.userId)
      },
      success_url: `${origin}/portal.html?paid=1`,
      cancel_url: `${origin}/portal.html?paid=0`
    });

    return res.json({ ok: true, url: session.url });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not create checkout session' });
  }
});

app.post('/api/member/addons/checkout', async (req, res) => {
  if (!stripe) return res.status(500).json({ ok: false, error: 'Stripe not configured' });
  const addonKey = String(req.body?.addonKey || '').trim();
  const addon = PORTAL_ADDONS[addonKey];
  if (!addon) return res.status(400).json({ ok: false, error: 'Invalid addon' });

  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const origin = getOrigin(req);
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: 'usd',
          unit_amount: addon.amount,
          product_data: { name: `Ventus Add-on: ${addon.name}` }
        },
        quantity: 1
      }],
      metadata: {
        kind: 'addon_purchase',
        user_id: String(auth.userId),
        addon_key: addonKey,
        addon_amount: String(addon.amount)
      },
      success_url: `${origin}/portal.html?addon=1`,
      cancel_url: `${origin}/portal.html?addon=0`
    });

    return res.json({ ok: true, url: session.url });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not create addon checkout' });
  }
});

app.post('/api/member/verification/evidence', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const appRow = await dbGet(
      `SELECT id FROM studio_applications WHERE email = ? ORDER BY id DESC LIMIT 1`,
      [auth.email]
    );
    if (!appRow) return res.status(404).json({ ok: false, error: 'Application not found' });

    const payload = req.body || {};
    const einLetter = payload.einLetterProvided ? 1 : 0;
    const formationDoc = payload.formationDocProvided ? 1 : 0;
    const bankProof = payload.bankProofProvided ? 1 : 0;
    const notes = String(payload.evidenceNotes || '').trim();

    await dbRun(
      `INSERT INTO verification_evidence (
        application_id, user_id, ein_letter_provided, formation_doc_provided,
        bank_proof_provided, evidence_notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [appRow.id, auth.userId, einLetter, formationDoc, bankProof, notes]
    );

    return res.json({ ok: true });
  } catch (error) {
    console.error('[verification] evidence save failed', error.message);
    return res.status(500).json({ ok: false, error: 'Could not save evidence' });
  }
});

app.post('/api/member/verification/run', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const appRow = await dbGet(
      `SELECT id, business_legal_name, ein, email, package_interest
       FROM studio_applications
       WHERE email = ?
       ORDER BY id DESC LIMIT 1`,
      [auth.email]
    );
    if (!appRow) return res.status(404).json({ ok: false, error: 'Application not found' });

    const evidence = await dbGet(
      `SELECT * FROM verification_evidence
       WHERE user_id = ?
       ORDER BY id DESC LIMIT 1`,
      [auth.userId]
    );

    const einRaw = String(appRow.ein || '').trim();
    const einDigits = einRaw.replace(/\D/g, '');
    const einValid = einDigits.length === 9;

    const emailDomain = String(appRow.email || '').split('@')[1] || '';
    const businessNormalized = String(appRow.business_legal_name || '').toLowerCase();
    const domainStem = emailDomain.split('.')[0]?.toLowerCase() || '';
    const emailDomainMatch = !!domainStem && businessNormalized.replace(/[^a-z0-9]/g, '').includes(domainStem.replace(/[^a-z0-9]/g, ''));
    const businessNamePresent = businessNormalized.length > 2;

    const hasEinLetter = !!evidence?.ein_letter_provided;
    const hasFormationDoc = !!evidence?.formation_doc_provided;
    const hasBankProof = !!evidence?.bank_proof_provided;

    let score = 0;
    if (einValid) score += 35;
    if (emailDomainMatch) score += 15;
    if (businessNamePresent) score += 10;
    if (hasEinLetter) score += 15;
    if (hasFormationDoc) score += 15;
    if (hasBankProof) score += 10;

    const status = score >= 75 ? 'passed' : score >= 55 ? 'needs_review' : 'failed';
    const notes = status === 'passed'
      ? 'Verification checks passed with evidence.'
      : status === 'needs_review'
        ? 'Verification partial. Manual review required.'
        : 'Verification failed. Missing required confidence signals.';

    await dbRun(
      `INSERT INTO verification_checks (application_id, user_id, provider, status, score, notes, ein_valid, email_domain_match, business_name_present, updated_at)
       VALUES (?, ?, 'manual_rules_v1', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [appRow.id, auth.userId, status, score, notes, einValid ? 1 : 0, emailDomainMatch ? 1 : 0, businessNamePresent ? 1 : 0]
    );

    let decision = 'pending';
    let approvedLimit = 0;
    let reason = 'Awaiting manual review';

    if (status === 'passed') {
      decision = 'approved';
      approvedLimit = appRow.package_interest === 'Authority' ? 3000 : appRow.package_interest === 'Growth' ? 2000 : 1000;
      reason = 'Auto-approved by rules + evidence score.';
      await dbRun(
        `UPDATE business_memberships
         SET approved_limit = ?, credit_limit_status = 'approved_not_active'
         WHERE user_id = ?`,
        [approvedLimit, auth.userId]
      );
    } else if (status === 'failed') {
      decision = 'declined';
      reason = 'Auto-declined: verification score below threshold.';
      await dbRun(
        `UPDATE business_memberships
         SET approved_limit = 0, active_limit = 0, credit_limit_status = 'declined'
         WHERE user_id = ?`,
        [auth.userId]
      );
    }

    await dbRun(
      `INSERT INTO underwriting_decisions (application_id, user_id, decision, approved_limit, reason, reviewer, updated_at)
       VALUES (?, ?, ?, ?, ?, 'system', CURRENT_TIMESTAMP)`,
      [appRow.id, auth.userId, decision, approvedLimit, reason]
    );

    return res.json({ ok: true, status, score, notes, decision, approvedLimit });
  } catch (error) {
    console.error('[verification] run failed', error.message);
    return res.status(500).json({ ok: false, error: 'Could not run verification' });
  }
});

app.post('/api/admin/underwriting/decide', async (req, res) => {
  try {
    const adminKey = process.env.VENTUS_ADMIN_KEY || '';
    const provided = req.get('x-admin-key') || '';
    if (!adminKey || provided !== adminKey) {
      return res.status(403).json({ ok: false, error: 'Forbidden' });
    }

    const userId = Number(req.body?.userId || 0);
    const decision = String(req.body?.decision || '').trim();
    const approvedLimit = Number(req.body?.approvedLimit || 0);
    const reason = String(req.body?.reason || '').trim() || 'Manual underwriting decision';
    const reviewer = String(req.body?.reviewer || 'admin').trim();

    if (!userId || !['approved', 'declined', 'pending'].includes(decision)) {
      return res.status(400).json({ ok: false, error: 'Invalid decision payload' });
    }

    const membership = await dbGet('SELECT * FROM business_memberships WHERE user_id = ? ORDER BY id DESC LIMIT 1', [userId]);
    if (!membership) return res.status(404).json({ ok: false, error: 'Membership not found' });

    const applicationId = membership.application_id || 0;

    await dbRun(
      `INSERT INTO underwriting_decisions (application_id, user_id, decision, approved_limit, reason, reviewer, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [applicationId, userId, decision, Math.max(0, approvedLimit), reason, reviewer]
    );

    if (decision === 'approved') {
      await dbRun(
        `UPDATE business_memberships
         SET approved_limit = ?,
             active_limit = 0,
             credit_limit_status = 'approved_not_active',
             membership_status = CASE WHEN membership_status = 'pending_payment' THEN membership_status ELSE 'pending_payment' END
         WHERE id = ?`,
        [Math.max(0, approvedLimit), membership.id]
      );
    } else if (decision === 'declined') {
      await dbRun(
        `UPDATE business_memberships
         SET approved_limit = 0,
             active_limit = 0,
             credit_limit_status = 'declined'
         WHERE id = ?`,
        [membership.id]
      );
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('[underwriting] decision failed', error.message);
    return res.status(500).json({ ok: false, error: 'Could not save decision' });
  }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  service: 'Ventus',
  stripeConfigured: !!stripe,
  checkoutProducts: Object.keys(CHECKOUT_PRODUCTS).length,
  mappedPrices: Object.keys(STRIPE_PRICE_MAP || {}).length,
  beehiivConfigured: !!beehiivApiKey
}));
app.get('*', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

app.listen(PORT, () => console.log(`🚀 Ventus on port ${PORT}`));