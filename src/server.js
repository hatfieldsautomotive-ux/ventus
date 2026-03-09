const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const Stripe = require('stripe');

const app = express();
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

const stripeSecret = process.env.STRIPE_SECRET_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

const PRODUCT_MAP = {
  'Ventus Elite Builder Pack': 'elite-builder',
  'Ventus CEO Operator Pack': 'ceo-operator',
  'Ventus Automotive Expert Pack': 'automotive-expert'
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

// Optional Stripe webhook for paid fulfillment token issuance
app.post('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  if (!stripe || !stripeWebhookSecret) return res.status(400).send('Stripe webhook not configured');

  let event;
  try {
    const sig = req.headers['stripe-signature'];
    event = stripe.webhooks.constructEvent(req.body, sig, stripeWebhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const email = session.customer_details?.email || '';

    // Resolve line items -> product names
    stripe.checkout.sessions.listLineItems(session.id, { expand: ['data.price.product'] })
      .then((items) => {
        items.data.forEach((item) => {
          const name = item.price.product.name;
          const product = PRODUCT_MAP[name];
          if (product) {
            issueToken(email, product, () => {});
          }
        });
      })
      .catch(() => {});
  }

  res.json({ received: true });
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', service: 'Ventus' }));
app.get('*', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

app.listen(PORT, () => console.log(`🚀 Ventus on port ${PORT}`));