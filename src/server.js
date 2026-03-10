const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const Stripe = require('stripe');

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
});

const stripeSecret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

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
  'stripe-revenue-ops': { name: 'Ventus Stripe Revenue Ops Collection', amount: 11900 }
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(WEB_DIR));

function issueToken(email, product, cb) {
  const token = crypto.randomBytes(24).toString('hex');
  const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(); // 7 days
  db.run(
    'INSERT INTO paid_tokens (email, product, token, expires_at) VALUES (?, ?, ?, ?)',
    [email || '', product, token, expires],
    (err) => cb(err, token)
  );
}

// Free download gate: simple email capture then redirect
app.post('/api/free-signup', (req, res) => {
  const { email, source = 'kitt-sidekick' } = req.body;
  if (!email || !email.includes('@')) return res.status(400).json({ error: 'Valid email required' });

  db.run('INSERT INTO newsletter_signups (email, source) VALUES (?, ?)', [email.trim().toLowerCase(), source], (err) => {
    if (err) return res.status(500).json({ error: 'Could not save signup' });
    return res.json({ ok: true, downloadUrl: '/downloads/kitt-sidekick.zip' });
  });
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
    const host = req.get('host');
    const inferredOrigin = host ? `https://${host}` : null;
    const origin = process.env.PUBLIC_BASE_URL || inferredOrigin || `${req.protocol}://${host}`;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'usd',
            unit_amount: cfg.amount,
            product_data: { name: cfg.name }
          },
          quantity: 1
        }
      ],
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

// Verify checkout session and issue one-time download token
app.get('/api/checkout-complete', async (req, res) => {
  if (!stripe) return res.status(500).json({ error: 'Stripe not configured' });
  const { session_id, product } = req.query;
  if (!session_id || !product) return res.status(400).json({ error: 'Missing params' });

  const cfg = CHECKOUT_PRODUCTS[product];
  if (!cfg) return res.status(400).json({ error: 'Invalid product' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    if (session.payment_status !== 'paid') return res.status(402).json({ error: 'Payment not completed' });
    if (session.amount_total !== cfg.amount) return res.status(400).json({ error: 'Amount mismatch' });

    const email = session.customer_details?.email || '';
    issueToken(email, product, (err, token) => {
      if (err) return res.status(500).json({ error: 'Token issue failed' });
      return res.json({ ok: true, downloadUrl: `/api/download/${product}?token=${token}` });
    });
  } catch (e) {
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// Optional Stripe webhook for future email fulfillment
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(400).send('Stripe webhook not configured');
  return res.json({ received: true });
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  service: 'Ventus',
  stripeConfigured: !!stripe,
  checkoutProducts: Object.keys(CHECKOUT_PRODUCTS).length
}));
app.get('*', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

app.listen(PORT, () => console.log(`🚀 Ventus on port ${PORT}`));