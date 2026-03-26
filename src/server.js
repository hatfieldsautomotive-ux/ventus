const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const { createClient } = require('@supabase/supabase-js');
const { promisify } = require('util');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3460;
const WEB_DIR = path.join(__dirname, '..', 'web');
const PRIVATE_DOWNLOADS = path.join(__dirname, '..', 'private-downloads');
const VERIFICATION_EVIDENCE_DIR = path.join(PRIVATE_DOWNLOADS, 'verification-evidence');
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'downloads.db');
const REQUESTED_DB_PATH = process.env.VENTUS_DB_PATH || process.env.DATABASE_PATH || DEFAULT_DB_PATH;

function resolveDbPath(inputPath) {
  const raw = String(inputPath || '').trim();
  if (!raw) return DEFAULT_DB_PATH;

  try {
    if (fs.existsSync(raw) && fs.statSync(raw).isDirectory()) {
      const resolved = path.join(raw, 'downloads.db');
      console.warn(`[db] VENTUS_DB_PATH points to a directory. Using ${resolved}`);
      return resolved;
    }
  } catch (err) {
    console.warn(`[db] could not inspect requested DB path (${raw}): ${err.message}`);
  }

  if (/[\\/]$/.test(raw)) {
    const resolved = path.join(raw, 'downloads.db');
    console.warn(`[db] VENTUS_DB_PATH looks like a directory path. Using ${resolved}`);
    return resolved;
  }

  return raw;
}

let DB_PATH = resolveDbPath(REQUESTED_DB_PATH);

function ensureDbPathWritable(targetPath) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const fd = fs.openSync(targetPath, 'a');
  fs.closeSync(fd);
}

function isRepoLocalDb(targetPath) {
  const normalized = path.normalize(targetPath).toLowerCase();
  return normalized.includes(`${path.sep}ventus${path.sep}data${path.sep}`) || normalized.endsWith(`${path.sep}data${path.sep}downloads.db`);
}

try {
  ensureDbPathWritable(DB_PATH);
} catch (err) {
  console.warn(`[db] requested path not writable (${DB_PATH}): ${err.code || err.message}`);

  const isProd = process.env.NODE_ENV === 'production';
  const userProvidedPath = !!(process.env.VENTUS_DB_PATH || process.env.DATABASE_PATH);

  if (isProd && userProvidedPath) {
    console.error('[db] Refusing to fall back in production because a custom DB path was provided but is not writable.');
    process.exit(1);
  }

  DB_PATH = DEFAULT_DB_PATH;
  ensureDbPathWritable(DB_PATH);
}

if (process.env.NODE_ENV === 'production' && !process.env.VENTUS_DB_PATH && !process.env.DATABASE_PATH) {
  console.warn('[db] WARNING: Using default local DB path in production. Configure VENTUS_DB_PATH to a persistent volume path to prevent signups/admin logins from being lost on updates.');
}

if (process.env.NODE_ENV === 'production' && isRepoLocalDb(DB_PATH)) {
  console.warn(`[db] WARNING: DB path appears repo-local (${DB_PATH}). Use VENTUS_DB_PATH to point to persistent storage outside the deploy bundle.`);
}

function safeIsoStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function backupDbOnBoot(dbPath) {
  const backupsEnabled = String(process.env.VENTUS_DB_BACKUP_ON_BOOT || 'true').toLowerCase() !== 'false';
  if (!backupsEnabled) return;

  if (!fs.existsSync(dbPath)) return;

  const stat = fs.statSync(dbPath);
  if (!stat.size) return;

  const backupDir = process.env.VENTUS_DB_BACKUP_DIR || path.join(path.dirname(dbPath), 'backups');
  fs.mkdirSync(backupDir, { recursive: true });

  const backupPath = path.join(backupDir, `downloads-${safeIsoStamp()}.db`);
  fs.copyFileSync(dbPath, backupPath);
  console.log(`[db] startup backup created: ${backupPath}`);

  const keep = Math.max(1, Number(process.env.VENTUS_DB_BACKUP_KEEP || 10));
  const backupFiles = fs.readdirSync(backupDir)
    .filter((name) => /^downloads-.*\.db$/i.test(name))
    .map((name) => ({
      name,
      fullPath: path.join(backupDir, name),
      mtimeMs: fs.statSync(path.join(backupDir, name)).mtimeMs
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const oldFile of backupFiles.slice(keep)) {
    try {
      fs.unlinkSync(oldFile.fullPath);
    } catch (err) {
      console.warn(`[db] backup prune failed for ${oldFile.name}: ${err.message}`);
    }
  }
}

backupDbOnBoot(DB_PATH);

fs.mkdirSync(PRIVATE_DOWNLOADS, { recursive: true });
fs.mkdirSync(VERIFICATION_EVIDENCE_DIR, { recursive: true });

const db = new sqlite3.Database(DB_PATH);
const MIGRATION_TABLES = [];
function runMigration(sql) {
  MIGRATION_TABLES.push(sql);
  db.run(sql);
}

db.serialize(() => {
  runMigration(`CREATE TABLE IF NOT EXISTS newsletter_signups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    source TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS paid_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    product TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME,
    used_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS fulfilled_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    email TEXT,
    products TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS studio_applications (
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
  runMigration(`CREATE TABLE IF NOT EXISTS onboarding_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'started',
    started_ip TEXT,
    user_agent TEXT,
    application_id INTEGER,
    expires_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS member_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS member_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS business_memberships (
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
  runMigration(`CREATE TABLE IF NOT EXISTS addon_purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    addon_key TEXT NOT NULL,
    amount_cents INTEGER NOT NULL,
    stripe_session_id TEXT,
    status TEXT NOT NULL DEFAULT 'paid',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS verification_checks (
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
  runMigration(`CREATE TABLE IF NOT EXISTS underwriting_decisions (
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
  runMigration(`CREATE TABLE IF NOT EXISTS verification_evidence (
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
  runMigration(`CREATE TABLE IF NOT EXISTS verification_evidence_documents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    evidence_id INTEGER NOT NULL,
    application_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    original_name TEXT,
    mime_type TEXT,
    file_size INTEGER,
    stored_path TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'owner',
    active INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS admin_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_id INTEGER NOT NULL,
    token TEXT NOT NULL UNIQUE,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_user_id INTEGER,
    action TEXT NOT NULL,
    target_type TEXT,
    target_id TEXT,
    payload_json TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS application_workflow (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL UNIQUE,
    user_id INTEGER,
    status TEXT NOT NULL DEFAULT 'new',
    assignee TEXT,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS application_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    admin_user_id INTEGER,
    note TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS project_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'todo',
    assignee TEXT,
    due_date TEXT,
    created_by_admin_user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS project_milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    due_date TEXT,
    completed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS client_deliverables (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    file_url TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    due_date TEXT,
    requires_approval INTEGER DEFAULT 1,
    approved_at DATETIME,
    approved_by_user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS client_deliverable_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deliverable_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    feedback TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS support_threads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    subject TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    priority TEXT NOT NULL DEFAULT 'normal',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS support_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id INTEGER NOT NULL,
    author_type TEXT NOT NULL,
    admin_user_id INTEGER,
    user_id INTEGER,
    message TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS project_questionnaires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL,
    template_key TEXT,
    title TEXT NOT NULL,
    questions_json TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'sent',
    created_by_admin_user_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  runMigration(`CREATE TABLE IF NOT EXISTS questionnaire_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    questionnaire_id INTEGER NOT NULL,
    answers_json TEXT NOT NULL,
    submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
});

console.log(`[db] using path: ${DB_PATH}`);
db.all("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", (err, rows) => {
  if (err) {
    console.error('[db] migration check failed', err.message);
    return;
  }
  console.log(`[db] schema ready (${rows.length} tables): ${rows.map((r) => r.name).join(', ')}`);
});

const stripeSecret = process.env.STRIPE_SECRET_KEY || process.env.STRIPE_API_KEY;
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const stripe = stripeSecret ? new Stripe(stripeSecret) : null;

const supabaseUrl = String(process.env.SUPABASE_URL || '').trim();
const supabaseAnonKey = String(process.env.SUPABASE_ANON_KEY || '').trim();
const supabaseServiceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const supabaseUrlValid = /^https?:\/\//i.test(supabaseUrl);
const supabaseEnabled = !!(supabaseUrlValid && supabaseAnonKey && supabaseServiceRoleKey);

if ((supabaseUrl || supabaseAnonKey || supabaseServiceRoleKey) && !supabaseEnabled) {
  console.warn('[supabase] disabled: SUPABASE_URL must be a valid https URL and keys must be set. Falling back to SQLite mode.');
}

const supabaseAnon = supabaseEnabled ? createClient(supabaseUrl, supabaseAnonKey) : null;
const supabaseAdmin = supabaseEnabled ? createClient(supabaseUrl, supabaseServiceRoleKey) : null;

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

const PROJECT_TASK_TEMPLATES = {
  foundation: [
    'Kickoff call + intake confirmation',
    'Collect brand assets and references',
    'Build core website pages',
    'Design and deliver logo package',
    'QA + mobile responsiveness pass',
    'Launch and handoff'
  ],
  growth: [
    'Kickoff call + intake confirmation',
    'Collect brand assets and references',
    'Build core website pages',
    'Design and deliver logo package',
    'Configure social posting calendar',
    'Implement local SEO basics',
    'Monthly strategy review setup'
  ],
  authority: [
    'Kickoff call + intake confirmation',
    'Collect brand assets and references',
    'Build core website pages',
    'Design and deliver logo package',
    'Configure social posting calendar',
    'Implement local SEO basics',
    'Build conversion landing page sprint',
    'Set up reporting dashboard + priority support lane'
  ]
};

const QUESTIONNAIRE_TEMPLATES = {
  website_kickoff: {
    title: 'Website Kickoff Questionnaire',
    questions: [
      'What is your primary business goal for this website in the next 90 days?',
      'Who is your ideal customer and what action should they take on the site?',
      'List 3 competitor websites you like and why.',
      'What services should be featured above the fold?',
      'What trust signals can we include? (reviews, certifications, years in business, etc.)'
    ]
  },
  brand_identity: {
    title: 'Brand Identity Questionnaire',
    questions: [
      'What 3 words should describe your brand personality?',
      'Are there colors or styles you want to avoid?',
      'Do you have an existing logo or brand assets we should reference?',
      'What should customers feel after seeing your brand?',
      'Where will your logo be used most? (site, social, print, vehicle, etc.)'
    ]
  },
  social_media: {
    title: 'Social Media Growth Questionnaire',
    questions: [
      'Which social channels matter most to your business right now?',
      'What content types perform best for your audience? (before/after, education, offers, etc.)',
      'How often can your team capture photos/videos each week?',
      'What offers or promotions should we push this month?',
      'List any compliance or tone constraints for your posts.'
    ]
  }
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

function sanitizeFilename(input, fallback = 'document') {
  const cleaned = String(input || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return cleaned || fallback;
}

function getFileExt(name = '') {
  return path.extname(String(name || '')).toLowerCase();
}

const ALLOWED_EVIDENCE_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.webp', '.doc', '.docx']);
const ALLOWED_EVIDENCE_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
]);

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function setAdminSessionCookie(res, token) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `ventus_admin_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure ? '; Secure' : ''}`);
}

function clearAdminSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production';
  res.setHeader('Set-Cookie', `ventus_admin_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
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

async function ensureSupabaseProfile(userId, email, role = 'member', active = true) {
  if (!supabaseEnabled) return;
  const normalizedEmail = (email || '').toLowerCase();

  let payload = { id: userId, email: normalizedEmail, role, active };
  let { error } = await supabaseAdmin
    .from('profiles')
    .upsert(payload, { onConflict: 'id' });

  if (error) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes("could not find the 'active' column")) {
      payload = { id: userId, email: normalizedEmail, role };
      ({ error } = await supabaseAdmin.from('profiles').upsert(payload, { onConflict: 'id' }));
    }
  }

  if (error) {
    const message = String(error.message || '').toLowerCase();
    if (message.includes("could not find the 'role' column")) {
      payload = { id: userId, email: normalizedEmail };
      ({ error } = await supabaseAdmin.from('profiles').upsert(payload, { onConflict: 'id' }));
    }
  }

  if (!error) return;

  const msg = String(error.message || '').toLowerCase();
  if (msg.includes('profiles_email_key') || msg.includes('duplicate key value')) {
    const { data: existing } = await supabaseAdmin
      .from('profiles')
      .select('id,email')
      .eq('email', normalizedEmail)
      .maybeSingle();

    if (existing?.id && existing.id !== userId) {
      // hard reconcile: remove stale profile row and recreate with correct auth user id
      const { error: deleteErr } = await supabaseAdmin
        .from('profiles')
        .delete()
        .eq('email', normalizedEmail);
      if (deleteErr) throw new Error(`Profile email conflict delete failed: ${deleteErr.message}`);

      const { error: insertErr } = await supabaseAdmin
        .from('profiles')
        .insert({ id: userId, email: normalizedEmail, role, active });
      if (!insertErr) return;

      throw new Error(`Profile email conflict could not be reconciled: ${insertErr.message}`);
    }
  }

  throw new Error(`Could not ensure profile: ${error.message}`);
}

async function ensureSupabaseUser(email, password) {
  const normalizedEmail = String(email || '').trim().toLowerCase();

  const createResp = await supabaseAdmin.auth.admin.createUser({
    email: normalizedEmail,
    password,
    email_confirm: true
  });

  if (!createResp.error && createResp.data?.user) {
    return { user: createResp.data.user, created: true };
  }

  const errMsg = String(createResp.error?.message || '').toLowerCase();
  if (!errMsg.includes('already') && !errMsg.includes('exists') && !errMsg.includes('registered')) {
    throw createResp.error || new Error('Could not create Supabase user');
  }

  const signInResp = await supabaseAnon.auth.signInWithPassword({ email: normalizedEmail, password });
  if (signInResp.error || !signInResp.data?.user) {
    throw new Error('Email already exists. Use the existing account password to continue.');
  }

  return { user: signInResp.data.user, created: false, session: signInResp.data.session };
}

async function getAuthedUser(req) {
  const cookies = parseCookies(req);
  const sessionToken = cookies.ventus_session;
  if (!sessionToken) return null;

  if (supabaseEnabled) {
    const { data, error } = await supabaseAdmin.auth.getUser(sessionToken);
    if (error || !data?.user) return null;
    return { userId: data.user.id, email: data.user.email || '' };
  }

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

async function getAuthedAdmin(req) {
  const cookies = parseCookies(req);
  const token = cookies.ventus_admin_session;
  if (!token) return null;

  if (supabaseEnabled) {
    const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !authData?.user) return null;

    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('*')
      .eq('id', authData.user.id)
      .maybeSingle();

    const active = profile && Object.prototype.hasOwnProperty.call(profile, 'active') ? !!profile.active : true;
    const role = profile?.role || 'member';
    if (!active) return null;
    if (!['admin', 'owner'].includes(role)) return null;
    return { adminUserId: authData.user.id, email: profile?.email || authData.user.email || '', role };
  }

  const session = await dbGet(
    `SELECT s.admin_user_id, s.expires_at, a.email, a.role, a.active
     FROM admin_sessions s
     JOIN admin_users a ON a.id = s.admin_user_id
     WHERE s.token = ?`,
    [token]
  );
  if (!session) return null;
  if (!session.active) return null;
  if (new Date(session.expires_at) < new Date()) return null;
  return { adminUserId: session.admin_user_id, email: session.email, role: session.role };
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

  const einDigits = String(payload.ein || '').replace(/\D/g, '');
  if (einDigits.length !== 9) return res.status(400).json({ ok: false, error: 'Valid EIN is required (9 digits)' });

  try {
    const onboarding = await dbGet('SELECT * FROM onboarding_sessions WHERE token = ?', [String(payload.onboardingToken)]);
    if (!onboarding) return res.status(404).json({ ok: false, error: 'Invalid onboarding session' });
    if (onboarding.status === 'completed') return res.status(410).json({ ok: false, error: 'Onboarding session already used' });
    if (onboarding.expires_at && new Date(onboarding.expires_at) < new Date()) return res.status(410).json({ ok: false, error: 'Onboarding session expired' });

    const servicesNeeded = Array.isArray(payload.servicesNeeded)
      ? payload.servicesNeeded.map((s) => String(s).trim()).filter(Boolean)
      : [];

    if (supabaseEnabled) {
      const ensured = await ensureSupabaseUser(normalizedEmail, String(payload.password));
      const user = ensured.user;
      await ensureSupabaseProfile(user.id, normalizedEmail, 'member', true);

      const { data: appRow, error: appErr } = await supabaseAdmin
        .from('studio_applications')
        .insert({
          user_id: user.id,
          business_legal_name: String(payload.businessLegalName || '').trim(),
          dba: String(payload.dba || '').trim(),
          ein: `${einDigits.slice(0, 2)}-${einDigits.slice(2)}`,
          entity_type: String(payload.entityType || '').trim(),
          contact_name: String(payload.contactName || '').trim(),
          email: normalizedEmail,
          phone: String(payload.phone || '').trim(),
          package_interest: String(payload.packageInterest || '').trim(),
          website_url: String(payload.websiteUrl || '').trim(),
          monthly_revenue_band: String(payload.monthlyRevenueBand || '').trim(),
          services_needed: servicesNeeded.join(','),
          consent_terms: !!payload.consentTerms,
          consent_reporting: !!payload.consentReporting,
          raw_json: payload
        })
        .select('id')
        .single();
      if (appErr) throw appErr;

      const applicationId = appRow.id;

      await supabaseAdmin.from('business_memberships').insert({
        user_id: user.id,
        application_id: applicationId,
        business_name: String(payload.businessLegalName || '').trim(),
        plan: String(payload.packageInterest || 'Foundation').trim(),
        membership_status: 'pending_payment',
        credit_limit_status: 'verification_pending',
        approved_limit: 0,
        active_limit: 0
      });

      await supabaseAdmin.from('verification_checks').insert({
        application_id: applicationId,
        user_id: user.id,
        provider: 'manual_rules_v1',
        status: 'pending',
        score: 0,
        notes: 'Awaiting verification run'
      });

      await supabaseAdmin.from('underwriting_decisions').insert({
        application_id: applicationId,
        user_id: user.id,
        decision: 'pending',
        approved_limit: 0,
        reason: 'Verification not completed',
        reviewer: 'system'
      });

      await dbRun('UPDATE onboarding_sessions SET status = ?, application_id = ? WHERE token = ?', ['completed', applicationId, String(payload.onboardingToken)]);

      const loginResp = await supabaseAnon.auth.signInWithPassword({ email: normalizedEmail, password: String(payload.password) });
      if (loginResp.error || !loginResp.data?.session?.access_token) {
        return res.status(500).json({ ok: false, error: 'Application saved but could not create login session. Please sign in from portal.' });
      }

      setSessionCookie(res, loginResp.data.session.access_token);
      return res.json({ ok: true, id: applicationId, redirect: '/portal.html' });
    }

    const insertApp = await dbRun(
      `INSERT INTO studio_applications (
        business_legal_name, dba, ein, entity_type, contact_name, email, phone,
        package_interest, website_url, monthly_revenue_band, services_needed,
        consent_terms, consent_reporting, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        String(payload.businessLegalName || '').trim(),
        String(payload.dba || '').trim(),
        `${einDigits.slice(0, 2)}-${einDigits.slice(2)}`,
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

    await dbRun(
      `INSERT OR IGNORE INTO application_workflow (application_id, user_id, status, assignee)
       VALUES (?, ?, 'new', 'unassigned')`,
      [applicationId, user.id]
    );

    await dbRun('UPDATE onboarding_sessions SET status = ?, application_id = ? WHERE token = ?', ['completed', applicationId, String(payload.onboardingToken)]);

    const sessionToken = crypto.randomBytes(32).toString('hex');
    const sessionExpires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    await dbRun('INSERT INTO member_sessions (user_id, token, expires_at) VALUES (?, ?, ?)', [user.id, sessionToken, sessionExpires]);
    setSessionCookie(res, sessionToken);

    return res.json({ ok: true, id: applicationId, redirect: '/portal.html' });
  } catch (error) {
    const details = error?.message || error?.code || 'unknown_error';
    console.error('[studio-application] submit failed', details, error?.stack || '');
    const safeMessage = process.env.NODE_ENV === 'production'
      ? `Could not submit application (${details})`
      : `Could not submit application (${details})`;
    return res.status(500).json({ ok: false, error: safeMessage });
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
    if (supabaseEnabled) {
      const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
      if (error || !data?.session?.access_token) return res.status(401).json({ ok: false, error: 'Invalid credentials' });
      await ensureSupabaseProfile(data.user.id, email, 'member', true);
      setSessionCookie(res, data.session.access_token);
      return res.json({ ok: true });
    }

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
    if (!supabaseEnabled) {
      const cookies = parseCookies(req);
      if (cookies.ventus_session) {
        await dbRun('DELETE FROM member_sessions WHERE token = ?', [cookies.ventus_session]);
      }
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

    if (supabaseEnabled) {
      const { data: membership } = await supabaseAdmin
        .from('business_memberships')
        .select('*')
        .eq('user_id', auth.userId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: addons } = await supabaseAdmin
        .from('addon_purchases')
        .select('addon_key,amount_cents,created_at')
        .eq('user_id', auth.userId)
        .order('id', { ascending: false })
        .limit(20);

      const { data: verification } = await supabaseAdmin
        .from('verification_checks')
        .select('status,score,notes,provider,updated_at')
        .eq('user_id', auth.userId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: evidence } = await supabaseAdmin
        .from('verification_evidence')
        .select('ein_letter_provided,formation_doc_provided,bank_proof_provided,evidence_notes,updated_at')
        .eq('user_id', auth.userId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: underwriting } = await supabaseAdmin
        .from('underwriting_decisions')
        .select('decision,approved_limit,reason,reviewer,updated_at')
        .eq('user_id', auth.userId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      const evidenceDocuments = await new Promise((resolve, reject) => {
        db.all(
          `SELECT id, original_name, mime_type, file_size, created_at
           FROM verification_evidence_documents
           WHERE user_id = ?
           ORDER BY id DESC LIMIT 5`,
          [auth.userId],
          (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
      });

      return res.json({
        ok: true,
        user: { email: auth.email },
        membership: membership || null,
        addons: addons || [],
        verification: verification || null,
        evidence: evidence || null,
        evidenceDocuments,
        underwriting: underwriting || null
      });
    }

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

    const evidenceDocuments = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, original_name, mime_type, file_size, created_at
         FROM verification_evidence_documents
         WHERE user_id = ?
         ORDER BY id DESC LIMIT 5`,
        [auth.userId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    return res.json({
      ok: true,
      user: { email: auth.email },
      membership: membership || null,
      addons,
      verification: verification || null,
      evidence: evidence || null,
      evidenceDocuments,
      underwriting: underwriting || null
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not load profile' });
  }
});

app.get('/api/member/workspace', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const appRow = await dbGet(
      `SELECT id, business_legal_name FROM studio_applications WHERE email = ? ORDER BY id DESC LIMIT 1`,
      [auth.email]
    );
    if (!appRow) return res.status(404).json({ ok: false, error: 'Application not found' });

    const workflow = await dbGet(
      `SELECT status, assignee, updated_at FROM application_workflow WHERE application_id = ? LIMIT 1`,
      [appRow.id]
    );

    const milestones = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, status, due_date, completed_at, created_at
         FROM project_milestones
         WHERE application_id = ?
         ORDER BY COALESCE(due_date, created_at) ASC, id ASC
         LIMIT 25`,
        [appRow.id],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const tasks = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, status, assignee, due_date, created_at, updated_at
         FROM project_tasks
         WHERE application_id = ?
         ORDER BY CASE status WHEN 'todo' THEN 0 WHEN 'in-progress' THEN 1 WHEN 'blocked' THEN 2 ELSE 3 END, COALESCE(due_date, created_at) ASC
         LIMIT 50`,
        [appRow.id],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const deliverables = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, description, file_url, status, due_date, requires_approval, approved_at, created_at
         FROM client_deliverables
         WHERE application_id = ?
         ORDER BY id DESC
         LIMIT 30`,
        [appRow.id],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const threads = await new Promise((resolve, reject) => {
      db.all(
        `SELECT st.id, st.subject, st.status, st.priority, st.created_at, st.updated_at,
                (SELECT sm.message FROM support_messages sm WHERE sm.thread_id = st.id ORDER BY sm.id DESC LIMIT 1) AS last_message,
                (SELECT sm.created_at FROM support_messages sm WHERE sm.thread_id = st.id ORDER BY sm.id DESC LIMIT 1) AS last_message_at
         FROM support_threads st
         WHERE st.application_id = ? AND st.user_id = ?
         ORDER BY st.updated_at DESC, st.id DESC
         LIMIT 20`,
        [appRow.id, auth.userId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const nextActions = [
      ...tasks.filter((t) => ['todo', 'in-progress', 'blocked'].includes(String(t.status || '').toLowerCase())).slice(0, 3).map((t) => ({
        type: 'task',
        label: t.title,
        dueDate: t.due_date || null
      })),
      ...deliverables.filter((d) => String(d.status || '').toLowerCase() === 'pending' && !!d.requires_approval).slice(0, 2).map((d) => ({
        type: 'approval',
        label: `Review deliverable: ${d.title}`,
        dueDate: d.due_date || null
      }))
    ].slice(0, 5);

    return res.json({
      ok: true,
      project: {
        applicationId: appRow.id,
        businessName: appRow.business_legal_name || null,
        workflow: workflow || { status: 'new', assignee: null, updated_at: null },
        milestones,
        tasks,
        deliverables,
        supportThreads: threads,
        nextActions
      }
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not load workspace (${error?.message || 'unknown'})` });
  }
});

app.post('/api/member/deliverable/:id/approve', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const deliverableId = Number(req.params.id || 0);
    if (!deliverableId) return res.status(400).json({ ok: false, error: 'Invalid deliverable id' });

    const appRow = await dbGet(`SELECT id FROM studio_applications WHERE email = ? ORDER BY id DESC LIMIT 1`, [auth.email]);
    if (!appRow) return res.status(404).json({ ok: false, error: 'Application not found' });

    const row = await dbGet('SELECT id FROM client_deliverables WHERE id = ? AND application_id = ?', [deliverableId, appRow.id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Deliverable not found' });

    await dbRun(
      `UPDATE client_deliverables
       SET status = 'approved', approved_at = CURRENT_TIMESTAMP, approved_by_user_id = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [auth.userId, deliverableId]
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not approve deliverable (${error?.message || 'unknown'})` });
  }
});

app.post('/api/member/deliverable/:id/revision', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const deliverableId = Number(req.params.id || 0);
    const feedback = String(req.body?.feedback || '').trim();
    if (!deliverableId) return res.status(400).json({ ok: false, error: 'Invalid deliverable id' });
    if (!feedback) return res.status(400).json({ ok: false, error: 'Feedback is required' });

    const appRow = await dbGet(`SELECT id FROM studio_applications WHERE email = ? ORDER BY id DESC LIMIT 1`, [auth.email]);
    if (!appRow) return res.status(404).json({ ok: false, error: 'Application not found' });

    const row = await dbGet('SELECT id FROM client_deliverables WHERE id = ? AND application_id = ?', [deliverableId, appRow.id]);
    if (!row) return res.status(404).json({ ok: false, error: 'Deliverable not found' });

    await dbRun(`INSERT INTO client_deliverable_feedback (deliverable_id, user_id, feedback) VALUES (?, ?, ?)`, [deliverableId, auth.userId, feedback]);
    await dbRun(`UPDATE client_deliverables SET status = 'revision_requested', updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [deliverableId]);

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not submit revision request (${error?.message || 'unknown'})` });
  }
});

app.post('/api/member/support/thread', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const subject = String(req.body?.subject || '').trim();
    const message = String(req.body?.message || '').trim();
    const priority = ['low', 'normal', 'high'].includes(String(req.body?.priority || '').toLowerCase())
      ? String(req.body.priority).toLowerCase()
      : 'normal';

    if (!subject) return res.status(400).json({ ok: false, error: 'Subject is required' });
    if (!message) return res.status(400).json({ ok: false, error: 'Message is required' });

    const appRow = await dbGet(`SELECT id FROM studio_applications WHERE email = ? ORDER BY id DESC LIMIT 1`, [auth.email]);
    if (!appRow) return res.status(404).json({ ok: false, error: 'Application not found' });

    const thread = await dbRun(
      `INSERT INTO support_threads (application_id, user_id, subject, status, priority, updated_at)
       VALUES (?, ?, ?, 'open', ?, CURRENT_TIMESTAMP)`,
      [appRow.id, auth.userId, subject, priority]
    );

    await dbRun(
      `INSERT INTO support_messages (thread_id, author_type, user_id, message)
       VALUES (?, 'member', ?, ?)`,
      [thread.lastID, auth.userId, message]
    );

    return res.json({ ok: true, threadId: thread.lastID });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not create support thread (${error?.message || 'unknown'})` });
  }
});

app.post('/api/member/support/thread/:id/message', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const threadId = Number(req.params.id || 0);
    const message = String(req.body?.message || '').trim();
    if (!threadId) return res.status(400).json({ ok: false, error: 'Invalid thread id' });
    if (!message) return res.status(400).json({ ok: false, error: 'Message is required' });

    const thread = await dbGet('SELECT id, user_id FROM support_threads WHERE id = ?', [threadId]);
    if (!thread || Number(thread.user_id) !== Number(auth.userId)) {
      return res.status(404).json({ ok: false, error: 'Support thread not found' });
    }

    await dbRun(
      `INSERT INTO support_messages (thread_id, author_type, user_id, message)
       VALUES (?, 'member', ?, ?)`,
      [threadId, auth.userId, message]
    );

    await dbRun('UPDATE support_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [threadId]);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not send message (${error?.message || 'unknown'})` });
  }
});

app.get('/api/member/support/thread/:id', async (req, res) => {
  try {
    const auth = await getAuthedUser(req);
    if (!auth) return res.status(401).json({ ok: false, error: 'Not authenticated' });

    const threadId = Number(req.params.id || 0);
    if (!threadId) return res.status(400).json({ ok: false, error: 'Invalid thread id' });

    const thread = await dbGet('SELECT * FROM support_threads WHERE id = ? AND user_id = ?', [threadId, auth.userId]);
    if (!thread) return res.status(404).json({ ok: false, error: 'Support thread not found' });

    const messages = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, author_type, message, created_at
         FROM support_messages
         WHERE thread_id = ?
         ORDER BY id ASC
         LIMIT 200`,
        [threadId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    return res.json({ ok: true, thread, messages });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not load support thread (${error?.message || 'unknown'})` });
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

    const evidenceInsert = await dbRun(
      `INSERT INTO verification_evidence (
        application_id, user_id, ein_letter_provided, formation_doc_provided,
        bank_proof_provided, evidence_notes, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [appRow.id, auth.userId, einLetter, formationDoc, bankProof, notes]
    );

    const document = payload.document || null;
    if (document?.base64) {
      const maxBytes = 10 * 1024 * 1024;
      const docBuffer = Buffer.from(String(document.base64), 'base64');
      if (!docBuffer.length) {
        return res.status(400).json({ ok: false, error: 'Uploaded document is empty' });
      }
      if (docBuffer.length > maxBytes) {
        return res.status(400).json({ ok: false, error: 'Document too large (max 10MB)' });
      }

      const originalNameRaw = String(document.name || 'evidence-document');
      const originalName = sanitizeFilename(originalNameRaw || 'evidence-document');
      const ext = getFileExt(originalName);
      const mimeType = String(document.type || '').toLowerCase();

      if (!ALLOWED_EVIDENCE_EXTENSIONS.has(ext)) {
        return res.status(400).json({ ok: false, error: 'Unsupported file type. Allowed: PDF, PNG, JPG, WEBP, DOC, DOCX' });
      }
      if (mimeType && !ALLOWED_EVIDENCE_MIME_TYPES.has(mimeType)) {
        return res.status(400).json({ ok: false, error: 'Unsupported MIME type for uploaded document' });
      }

      const safeBase = sanitizeFilename(path.basename(originalName, ext), 'evidence-document');
      const storedName = `${Date.now()}-${auth.userId}-${safeBase}${ext.slice(0, 12)}`;
      const storedPath = path.join(VERIFICATION_EVIDENCE_DIR, storedName);

      fs.writeFileSync(storedPath, docBuffer);

      await dbRun(
        `INSERT INTO verification_evidence_documents (
          evidence_id, application_id, user_id, original_name, mime_type, file_size, stored_path
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          evidenceInsert.lastID,
          appRow.id,
          auth.userId,
          String(document.name || originalName),
          String(document.type || 'application/octet-stream'),
          docBuffer.length,
          storedPath
        ]
      );
    }

    return res.json({ ok: true });
  } catch (error) {
    console.error('[verification] evidence save failed', error.message);
    return res.status(500).json({ ok: false, error: 'Could not upload documents' });
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

async function requireAdmin(req, res) {
  const admin = await getAuthedAdmin(req);
  if (!admin) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return null;
  }
  return admin;
}

app.post('/api/admin/login', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ ok: false, error: 'Email and password required' });

    if (supabaseEnabled) {
      const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
      if (error || !data?.session?.access_token) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

      const { data: profile } = await supabaseAdmin
        .from('profiles')
        .select('*')
        .eq('id', data.user.id)
        .maybeSingle();

      const active = profile && Object.prototype.hasOwnProperty.call(profile, 'active') ? !!profile.active : true;
      const role = profile?.role || 'member';
      if (!active || !['admin', 'owner'].includes(role)) {
        return res.status(403).json({ ok: false, error: 'Forbidden' });
      }

      setAdminSessionCookie(res, data.session.access_token);
      return res.json({ ok: true });
    }

    const adminUser = await dbGet('SELECT * FROM admin_users WHERE email = ?', [email]);
    if (!adminUser || !adminUser.active) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const valid = await verifyPassword(password, adminUser.password_salt, adminUser.password_hash);
    if (!valid) return res.status(401).json({ ok: false, error: 'Invalid credentials' });

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 1000 * 60 * 60 * 24 * 30).toISOString();
    await dbRun('INSERT INTO admin_sessions (admin_user_id, token, expires_at) VALUES (?, ?, ?)', [adminUser.id, token, expiresAt]);
    setAdminSessionCookie(res, token);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not log in' });
  }
});

app.post('/api/admin/logout', async (req, res) => {
  try {
    if (!supabaseEnabled) {
      const cookies = parseCookies(req);
      if (cookies.ventus_admin_session) {
        await dbRun('DELETE FROM admin_sessions WHERE token = ?', [cookies.ventus_admin_session]);
      }
    }
    clearAdminSessionCookie(res);
    return res.json({ ok: true });
  } catch {
    clearAdminSessionCookie(res);
    return res.json({ ok: true });
  }
});

app.get('/api/admin/me', async (req, res) => {
  const admin = await getAuthedAdmin(req);
  if (!admin) return res.status(401).json({ ok: false, error: 'Not authenticated' });
  return res.json({ ok: true, admin });
});

app.post('/api/admin/bootstrap', async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password || password.length < 8) {
      return res.status(400).json({ ok: false, error: 'Valid email and password (8+ chars) required' });
    }

    if (supabaseEnabled) {
      const list = await supabaseAdmin.auth.admin.listUsers({ page: 1, perPage: 200 });
      const existingByEmail = (list.data?.users || []).find((u) => (u.email || '').toLowerCase() === email);

      if (existingByEmail) {
        await supabaseAdmin.auth.admin.updateUserById(existingByEmail.id, { password, email_confirm: true });
        await ensureSupabaseProfile(existingByEmail.id, email, 'owner', true);
        return res.json({ ok: true, reset: true });
      }

      let anyOwner = { data: [] };
      const ownerQuery = await supabaseAdmin.from('profiles').select('*').limit(200);
      if (!ownerQuery.error) {
        anyOwner.data = (ownerQuery.data || []).filter((p) => ['owner', 'admin'].includes(p.role || ''));
      }
      if (anyOwner.data && anyOwner.data.length) {
        return res.status(409).json({ ok: false, error: `Admin exists (${anyOwner.data[0].email || 'existing admin'}). Use that email to reset.` });
      }

      const created = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true });
      if (created.error || !created.data?.user) {
        return res.status(500).json({ ok: false, error: created.error?.message || 'Could not bootstrap admin' });
      }
      await ensureSupabaseProfile(created.data.user.id, email, 'owner', true);
      return res.json({ ok: true, created: true });
    }

    const pw = await hashPassword(password);
    const existingEmail = await dbGet('SELECT id, email FROM admin_users WHERE email = ?', [email]);

    if (existingEmail) {
      await dbRun(
        'UPDATE admin_users SET password_hash = ?, password_salt = ?, active = 1 WHERE id = ?',
        [pw.hash, pw.salt, existingEmail.id]
      );
      return res.json({ ok: true, reset: true });
    }

    const firstAdmin = await dbGet('SELECT id, email FROM admin_users ORDER BY id ASC LIMIT 1');
    if (firstAdmin) {
      return res.status(409).json({ ok: false, error: `Admin exists (${firstAdmin.email}). Use that email to reset.` });
    }

    await dbRun('INSERT INTO admin_users (email, password_hash, password_salt, role, active) VALUES (?, ?, ?, ?, 1)', [email, pw.hash, pw.salt, 'owner']);
    return res.json({ ok: true, created: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not bootstrap admin' });
  }
});

app.get('/api/admin/applications', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    if (supabaseEnabled) {
      const { data: apps, error } = await supabaseAdmin
        .from('studio_applications')
        .select('id,business_legal_name,email,package_interest,created_at,user_id')
        .order('id', { ascending: false })
        .limit(200);
      if (error) throw error;

      const appIds = (apps || []).map((a) => a.id);
      const userIds = (apps || []).map((a) => a.user_id).filter(Boolean);

      const { data: memberships } = await supabaseAdmin
        .from('business_memberships')
        .select('application_id,user_id,membership_status,credit_limit_status,approved_limit,active_limit')
        .in('application_id', appIds.length ? appIds : [-1]);

      const { data: verifications } = await supabaseAdmin
        .from('verification_checks')
        .select('application_id,status,score,id')
        .in('application_id', appIds.length ? appIds : [-1])
        .order('id', { ascending: false });

      const { data: underwriting } = await supabaseAdmin
        .from('underwriting_decisions')
        .select('application_id,decision,approved_limit,id')
        .in('application_id', appIds.length ? appIds : [-1])
        .order('id', { ascending: false });

      const membershipByApp = new Map((memberships || []).map((m) => [m.application_id, m]));
      const verificationByApp = new Map();
      for (const v of (verifications || [])) if (!verificationByApp.has(v.application_id)) verificationByApp.set(v.application_id, v);
      const underwritingByApp = new Map();
      for (const u of (underwriting || [])) if (!underwritingByApp.has(u.application_id)) underwritingByApp.set(u.application_id, u);

      const workflowRows = await new Promise((resolve, reject) => {
        db.all(
          `SELECT application_id, status, assignee
           FROM application_workflow
           WHERE application_id IN (${appIds.length ? appIds.map(() => '?').join(',') : '-1'})`,
          appIds.length ? appIds : [],
          (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
      });
      const workflowByApp = new Map((workflowRows || []).map((w) => [Number(w.application_id), w]));

      const rows = (apps || []).map((sa) => {
        const bm = membershipByApp.get(sa.id) || {};
        const vc = verificationByApp.get(sa.id) || {};
        const ud = underwritingByApp.get(sa.id) || {};
        const wf = workflowByApp.get(Number(sa.id)) || {};
        return {
          application_id: sa.id,
          business_legal_name: sa.business_legal_name,
          email: sa.email,
          package_interest: sa.package_interest,
          created_at: sa.created_at,
          user_id: sa.user_id,
          membership_status: bm.membership_status || null,
          credit_limit_status: bm.credit_limit_status || null,
          approved_limit: bm.approved_limit || 0,
          active_limit: bm.active_limit || 0,
          verification_status: vc.status || null,
          verification_score: vc.score || 0,
          underwriting_decision: ud.decision || null,
          underwriting_limit: ud.approved_limit || 0,
          workflow_status: wf.status || 'new',
          workflow_assignee: wf.assignee || 'unassigned',
          notes_count: 0,
          tasks_count: 0
        };
      });

      return res.json({ ok: true, applications: rows });
    }

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT sa.id AS application_id, sa.business_legal_name, sa.email, sa.package_interest, sa.created_at,
                bm.user_id, bm.membership_status, bm.credit_limit_status, bm.approved_limit, bm.active_limit,
                vc.status AS verification_status, vc.score AS verification_score,
                ud.decision AS underwriting_decision, ud.approved_limit AS underwriting_limit,
                aw.status AS workflow_status, aw.assignee AS workflow_assignee,
                (SELECT COUNT(1) FROM application_notes n WHERE n.application_id = sa.id) AS notes_count,
                (SELECT COUNT(1) FROM project_tasks t WHERE t.application_id = sa.id) AS tasks_count
         FROM studio_applications sa
         LEFT JOIN business_memberships bm ON bm.application_id = sa.id
         LEFT JOIN verification_checks vc ON vc.id = (
            SELECT id FROM verification_checks v2 WHERE v2.application_id = sa.id ORDER BY id DESC LIMIT 1
         )
         LEFT JOIN underwriting_decisions ud ON ud.id = (
            SELECT id FROM underwriting_decisions u2 WHERE u2.application_id = sa.id ORDER BY id DESC LIMIT 1
         )
         LEFT JOIN application_workflow aw ON aw.application_id = sa.id
         ORDER BY sa.id DESC
         LIMIT 200`,
        [],
        (err, result) => (err ? reject(err) : resolve(result || []))
      );
    });

    return res.json({ ok: true, applications: rows });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'Could not load applications' });
  }
});

app.post('/api/admin/application/status', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const applicationId = Number(req.body?.applicationId || 0);
    const status = String(req.body?.status || '').trim();
    const assignee = String(req.body?.assignee || 'unassigned').trim();
    const validStatuses = ['new', 'verifying', 'needs-review', 'approved', 'declined', 'activated'];
    if (!applicationId || !validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, error: 'Invalid status payload' });
    }

    let workflowUserId = null;

    if (supabaseEnabled) {
      const { data: membership, error: mErr } = await supabaseAdmin
        .from('business_memberships')
        .select('id,user_id,membership_status,credit_limit_status')
        .eq('application_id', applicationId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (mErr) throw mErr;

      workflowUserId = membership?.user_id || null;

      if (membership) {
        const patch = {};
        if (status === 'approved') {
          patch.credit_limit_status = membership.credit_limit_status === 'declined' ? 'verification_pending' : membership.credit_limit_status;
        } else if (status === 'declined') {
          patch.credit_limit_status = 'declined';
        } else if (status === 'activated') {
          patch.membership_status = 'active';
        }

        if (Object.keys(patch).length) {
          const { error: uErr } = await supabaseAdmin.from('business_memberships').update(patch).eq('id', membership.id);
          if (uErr) throw uErr;
        }
      }
    } else {
      const row = await dbGet('SELECT user_id FROM business_memberships WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicationId]);
      workflowUserId = row?.user_id || null;
    }

    await dbRun(
      `INSERT INTO application_workflow (application_id, user_id, status, assignee, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(application_id)
       DO UPDATE SET status=excluded.status, assignee=excluded.assignee, updated_at=CURRENT_TIMESTAMP`,
      [applicationId, workflowUserId, status, assignee]
    );

    await dbRun(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload_json)
       VALUES (?, 'application_status', 'application', ?, ?)`,
      [admin.adminUserId, String(applicationId), JSON.stringify({ status, assignee })]
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not update status (${error?.message || 'unknown'})` });
  }
});

app.get('/api/admin/application/:id/detail', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const applicationId = Number(req.params.id || 0);
    if (!applicationId) return res.status(400).json({ ok: false, error: 'Invalid application id' });

    if (supabaseEnabled) {
      const { data: app, error: appErr } = await supabaseAdmin
        .from('studio_applications')
        .select('*')
        .eq('id', applicationId)
        .maybeSingle();
      if (appErr) throw appErr;
      if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });

      const { data: membership } = await supabaseAdmin
        .from('business_memberships')
        .select('*')
        .eq('application_id', applicationId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: verification } = await supabaseAdmin
        .from('verification_checks')
        .select('*')
        .eq('application_id', applicationId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      const { data: underwriting } = await supabaseAdmin
        .from('underwriting_decisions')
        .select('*')
        .eq('application_id', applicationId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();

      const evidenceDocuments = await new Promise((resolve, reject) => {
        db.all(
          `SELECT id, original_name, mime_type, file_size, created_at
           FROM verification_evidence_documents
           WHERE application_id = ?
           ORDER BY id DESC LIMIT 20`,
          [applicationId],
          (err, rows) => (err ? reject(err) : resolve(rows || []))
        );
      });

      return res.json({ ok: true, application: app, membership: membership || null, verification: verification || null, underwriting: underwriting || null, evidenceDocuments });
    }

    const app = await dbGet('SELECT * FROM studio_applications WHERE id = ?', [applicationId]);
    if (!app) return res.status(404).json({ ok: false, error: 'Application not found' });
    const membership = await dbGet('SELECT * FROM business_memberships WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicationId]);
    const verification = await dbGet('SELECT * FROM verification_checks WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicationId]);
    const underwriting = await dbGet('SELECT * FROM underwriting_decisions WHERE application_id = ? ORDER BY id DESC LIMIT 1', [applicationId]);
    const evidenceDocuments = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, original_name, mime_type, file_size, created_at
         FROM verification_evidence_documents
         WHERE application_id = ?
         ORDER BY id DESC LIMIT 20`,
        [applicationId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
    return res.json({ ok: true, application: app, membership: membership || null, verification: verification || null, underwriting: underwriting || null, evidenceDocuments });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not load application detail (${error?.message || 'unknown'})` });
  }
});

app.get('/api/admin/evidence-document/:id/download', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const docId = Number(req.params.id || 0);
    if (!docId) return res.status(400).json({ ok: false, error: 'Invalid document id' });

    const doc = await dbGet(
      `SELECT id, original_name, mime_type, stored_path
       FROM verification_evidence_documents
       WHERE id = ?`,
      [docId]
    );

    if (!doc || !doc.stored_path || !fs.existsSync(doc.stored_path)) {
      return res.status(404).json({ ok: false, error: 'Document not found' });
    }

    const filename = sanitizeFilename(doc.original_name || `evidence-${doc.id}`);
    if (doc.mime_type) res.setHeader('Content-Type', doc.mime_type);
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.sendFile(path.resolve(doc.stored_path));
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not download document (${error?.message || 'unknown'})` });
  }
});

app.get('/api/admin/application/:id/workspace', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const applicationId = Number(req.params.id || 0);
    if (!applicationId) return res.status(400).json({ ok: false, error: 'Invalid application id' });

    const milestones = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, status, due_date, completed_at, created_at, updated_at
         FROM project_milestones
         WHERE application_id = ?
         ORDER BY COALESCE(due_date, created_at) ASC, id ASC`,
        [applicationId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const deliverables = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, description, file_url, status, due_date, requires_approval, approved_at, created_at, updated_at
         FROM client_deliverables
         WHERE application_id = ?
         ORDER BY id DESC`,
        [applicationId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    const threads = await new Promise((resolve, reject) => {
      db.all(
        `SELECT st.id, st.subject, st.status, st.priority, st.created_at, st.updated_at,
                (SELECT sm.message FROM support_messages sm WHERE sm.thread_id = st.id ORDER BY sm.id DESC LIMIT 1) AS last_message,
                (SELECT sm.created_at FROM support_messages sm WHERE sm.thread_id = st.id ORDER BY sm.id DESC LIMIT 1) AS last_message_at
         FROM support_threads st
         WHERE st.application_id = ?
         ORDER BY st.updated_at DESC, st.id DESC`,
        [applicationId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    return res.json({ ok: true, milestones, deliverables, threads });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not load workspace (${error?.message || 'unknown'})` });
  }
});

app.post('/api/admin/application/milestone', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const applicationId = Number(req.body?.applicationId || 0);
    const title = String(req.body?.title || '').trim();
    const dueDate = String(req.body?.dueDate || '').trim() || null;

    if (!applicationId) return res.status(400).json({ ok: false, error: 'Invalid application id' });
    if (!title) return res.status(400).json({ ok: false, error: 'Milestone title is required' });

    await dbRun(
      `INSERT INTO project_milestones (application_id, title, status, due_date, updated_at)
       VALUES (?, ?, 'pending', ?, CURRENT_TIMESTAMP)`,
      [applicationId, title, dueDate]
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not create milestone (${error?.message || 'unknown'})` });
  }
});

app.post('/api/admin/application/deliverable', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const applicationId = Number(req.body?.applicationId || 0);
    const title = String(req.body?.title || '').trim();
    const description = String(req.body?.description || '').trim();
    const fileUrl = String(req.body?.fileUrl || '').trim() || null;
    const dueDate = String(req.body?.dueDate || '').trim() || null;
    const requiresApproval = req.body?.requiresApproval === false ? 0 : 1;

    if (!applicationId) return res.status(400).json({ ok: false, error: 'Invalid application id' });
    if (!title) return res.status(400).json({ ok: false, error: 'Deliverable title is required' });

    await dbRun(
      `INSERT INTO client_deliverables (application_id, title, description, file_url, status, due_date, requires_approval, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, CURRENT_TIMESTAMP)`,
      [applicationId, title, description || null, fileUrl, dueDate, requiresApproval]
    );

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not create deliverable (${error?.message || 'unknown'})` });
  }
});

app.get('/api/admin/support/thread/:id', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const threadId = Number(req.params.id || 0);
    if (!threadId) return res.status(400).json({ ok: false, error: 'Invalid thread id' });

    const thread = await dbGet('SELECT * FROM support_threads WHERE id = ?', [threadId]);
    if (!thread) return res.status(404).json({ ok: false, error: 'Support thread not found' });

    const messages = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, author_type, message, created_at
         FROM support_messages
         WHERE thread_id = ?
         ORDER BY id ASC`,
        [threadId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    return res.json({ ok: true, thread, messages });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not load support thread (${error?.message || 'unknown'})` });
  }
});

app.post('/api/admin/support/thread/:id/message', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const threadId = Number(req.params.id || 0);
    const message = String(req.body?.message || '').trim();
    const status = String(req.body?.status || '').trim().toLowerCase();

    if (!threadId) return res.status(400).json({ ok: false, error: 'Invalid thread id' });
    if (!message) return res.status(400).json({ ok: false, error: 'Message is required' });

    const thread = await dbGet('SELECT id FROM support_threads WHERE id = ?', [threadId]);
    if (!thread) return res.status(404).json({ ok: false, error: 'Support thread not found' });

    await dbRun(
      `INSERT INTO support_messages (thread_id, author_type, admin_user_id, message)
       VALUES (?, 'admin', ?, ?)`,
      [threadId, admin.adminUserId || null, message]
    );

    if (['open', 'pending', 'resolved', 'closed'].includes(status)) {
      await dbRun('UPDATE support_threads SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [status, threadId]);
    } else {
      await dbRun('UPDATE support_threads SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [threadId]);
    }

    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ ok: false, error: `Could not reply to support thread (${error?.message || 'unknown'})` });
  }
});

app.get('/api/admin/application/:id/notes', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const applicationId = Number(req.params.id || 0);

    if (supabaseEnabled) {
      return res.json({ ok: true, notes: [] });
    }

    const notes = await new Promise((resolve, reject) => {
      db.all(
        `SELECT n.id, n.note, n.created_at, a.email AS admin_email
         FROM application_notes n
         LEFT JOIN admin_users a ON a.id = n.admin_user_id
         WHERE n.application_id = ?
         ORDER BY n.id DESC LIMIT 100`,
        [applicationId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
    return res.json({ ok: true, notes });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not load notes' });
  }
});

app.post('/api/admin/application/note', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const applicationId = Number(req.body?.applicationId || 0);
    const note = String(req.body?.note || '').trim();
    if (!applicationId || !note) return res.status(400).json({ ok: false, error: 'Invalid note payload' });

    await dbRun('INSERT INTO application_notes (application_id, admin_user_id, note) VALUES (?, ?, ?)', [applicationId, admin.adminUserId, note]);
    await dbRun(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload_json)
       VALUES (?, 'application_note', 'application', ?, ?)`,
      [admin.adminUserId, String(applicationId), JSON.stringify({ note })]
    );
    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not save note' });
  }
});

app.get('/api/admin/application/:id/tasks', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const applicationId = Number(req.params.id || 0);

    if (supabaseEnabled) {
      return res.json({ ok: true, tasks: [] });
    }

    const tasks = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, title, status, assignee, due_date, created_at, updated_at
         FROM project_tasks
         WHERE application_id = ?
         ORDER BY id DESC LIMIT 100`,
        [applicationId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });
    return res.json({ ok: true, tasks });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not load tasks' });
  }
});

app.post('/api/admin/application/task', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const applicationId = Number(req.body?.applicationId || 0);
    const title = String(req.body?.title || '').trim();
    const status = String(req.body?.status || 'todo').trim();
    const assignee = String(req.body?.assignee || 'unassigned').trim();
    const dueDate = String(req.body?.dueDate || '').trim();
    if (!applicationId || !title) return res.status(400).json({ ok: false, error: 'Invalid task payload' });

    await dbRun(
      `INSERT INTO project_tasks (application_id, title, status, assignee, due_date, created_by_admin_user_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [applicationId, title, status, assignee, dueDate, admin.adminUserId]
    );

    await dbRun(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload_json)
       VALUES (?, 'application_task', 'application', ?, ?)`,
      [admin.adminUserId, String(applicationId), JSON.stringify({ title, status, assignee, dueDate })]
    );

    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not create task' });
  }
});

app.post('/api/admin/application/task/update', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const taskId = Number(req.body?.taskId || 0);
    const status = String(req.body?.status || '').trim();
    const assignee = String(req.body?.assignee || '').trim();
    const dueDate = String(req.body?.dueDate || '').trim();
    const title = String(req.body?.title || '').trim();
    const validStatuses = ['todo', 'in-progress', 'done', 'blocked'];

    if (!taskId || !validStatuses.includes(status)) {
      return res.status(400).json({ ok: false, error: 'Invalid task update payload' });
    }

    const existing = await dbGet('SELECT * FROM project_tasks WHERE id = ?', [taskId]);
    if (!existing) return res.status(404).json({ ok: false, error: 'Task not found' });

    await dbRun(
      `UPDATE project_tasks
       SET title = ?, status = ?, assignee = ?, due_date = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [title || existing.title, status, assignee || existing.assignee, dueDate || existing.due_date, taskId]
    );

    await dbRun(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload_json)
       VALUES (?, 'application_task_update', 'task', ?, ?)`,
      [admin.adminUserId, String(taskId), JSON.stringify({ status, assignee, dueDate, title })]
    );

    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not update task' });
  }
});

app.post('/api/admin/application/tasks/apply-template', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const applicationId = Number(req.body?.applicationId || 0);
    if (!applicationId) return res.status(400).json({ ok: false, error: 'Application id required' });

    const appRow = await dbGet('SELECT package_interest FROM studio_applications WHERE id = ?', [applicationId]);
    if (!appRow) return res.status(404).json({ ok: false, error: 'Application not found' });

    const pkg = String(appRow.package_interest || 'Foundation').toLowerCase();
    const templateKey = pkg.includes('authority') ? 'authority' : pkg.includes('growth') ? 'growth' : 'foundation';
    const tasks = PROJECT_TASK_TEMPLATES[templateKey] || PROJECT_TASK_TEMPLATES.foundation;

    const existingRows = await new Promise((resolve, reject) => {
      db.all('SELECT title FROM project_tasks WHERE application_id = ?', [applicationId], (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
    const existing = new Set(existingRows.map((r) => String(r.title || '').toLowerCase().trim()));

    let inserted = 0;
    for (const title of tasks) {
      const key = title.toLowerCase().trim();
      if (existing.has(key)) continue;
      await dbRun(
        `INSERT INTO project_tasks (application_id, title, status, assignee, due_date, created_by_admin_user_id, updated_at)
         VALUES (?, ?, 'todo', 'unassigned', '', ?, CURRENT_TIMESTAMP)`,
        [applicationId, title, admin.adminUserId]
      );
      inserted += 1;
    }

    await dbRun(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload_json)
       VALUES (?, 'apply_task_template', 'application', ?, ?)`,
      [admin.adminUserId, String(applicationId), JSON.stringify({ templateKey, inserted })]
    );

    return res.json({ ok: true, templateKey, inserted });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not apply task template' });
  }
});

app.post('/api/admin/application/questionnaire/send', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const applicationId = Number(req.body?.applicationId || 0);
    const templateKey = String(req.body?.templateKey || '').trim();
    const customTitle = String(req.body?.title || '').trim();

    if (!applicationId) return res.status(400).json({ ok: false, error: 'Application id required' });

    const template = QUESTIONNAIRE_TEMPLATES[templateKey];
    if (!template) return res.status(400).json({ ok: false, error: 'Invalid questionnaire template' });

    const token = crypto.randomBytes(24).toString('hex');
    const title = customTitle || template.title;

    const row = await dbRun(
      `INSERT INTO project_questionnaires (application_id, template_key, title, questions_json, token, status, created_by_admin_user_id)
       VALUES (?, ?, ?, ?, ?, 'sent', ?)`,
      [applicationId, templateKey, title, JSON.stringify(template.questions), token, admin.adminUserId]
    );

    const origin = process.env.PUBLIC_BASE_URL || '';
    const shareUrl = `${origin}/questionnaire.html?token=${token}`;

    await dbRun(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload_json)
       VALUES (?, 'send_questionnaire', 'application', ?, ?)`,
      [admin.adminUserId, String(applicationId), JSON.stringify({ templateKey, questionnaireId: row.lastID, shareUrl })]
    );

    return res.json({ ok: true, questionnaireId: row.lastID, shareUrl });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not send questionnaire' });
  }
});

app.get('/api/admin/application/:id/questionnaires', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const applicationId = Number(req.params.id || 0);

    if (supabaseEnabled) {
      return res.json({ ok: true, questionnaires: [] });
    }

    const rows = await new Promise((resolve, reject) => {
      db.all(
        `SELECT q.id, q.template_key, q.title, q.status, q.token, q.created_at,
                (SELECT submitted_at FROM questionnaire_submissions s WHERE s.questionnaire_id = q.id ORDER BY id DESC LIMIT 1) AS submitted_at
         FROM project_questionnaires q
         WHERE q.application_id = ?
         ORDER BY q.id DESC`,
        [applicationId],
        (err, out) => (err ? reject(err) : resolve(out || []))
      );
    });
    const origin = process.env.PUBLIC_BASE_URL || '';
    return res.json({ ok: true, questionnaires: rows.map((r) => ({ ...r, share_url: `${origin}/questionnaire.html?token=${r.token}` })) });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not load questionnaires' });
  }
});

app.get('/api/admin/questionnaire/:id/submissions', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;
    const questionnaireId = Number(req.params.id || 0);
    if (!questionnaireId) return res.status(400).json({ ok: false, error: 'Questionnaire id required' });

    const questionnaire = await dbGet('SELECT id, title, questions_json FROM project_questionnaires WHERE id = ?', [questionnaireId]);
    if (!questionnaire) return res.status(404).json({ ok: false, error: 'Questionnaire not found' });

    const submissions = await new Promise((resolve, reject) => {
      db.all(
        `SELECT id, answers_json, submitted_at
         FROM questionnaire_submissions
         WHERE questionnaire_id = ?
         ORDER BY id DESC`,
        [questionnaireId],
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    return res.json({
      ok: true,
      questionnaire: {
        id: questionnaire.id,
        title: questionnaire.title,
        questions: JSON.parse(questionnaire.questions_json || '[]')
      },
      submissions: submissions.map((s) => ({
        id: s.id,
        submitted_at: s.submitted_at,
        answers: JSON.parse(s.answers_json || '[]')
      }))
    });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not load questionnaire submissions' });
  }
});

app.get('/api/questionnaire/:token', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const q = await dbGet('SELECT id, title, questions_json, status FROM project_questionnaires WHERE token = ?', [token]);
    if (!q) return res.status(404).json({ ok: false, error: 'Questionnaire not found' });
    return res.json({ ok: true, questionnaire: { id: q.id, title: q.title, questions: JSON.parse(q.questions_json || '[]'), status: q.status } });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not load questionnaire' });
  }
});

app.post('/api/questionnaire/:token/submit', async (req, res) => {
  try {
    const token = String(req.params.token || '').trim();
    const answers = Array.isArray(req.body?.answers) ? req.body.answers : [];
    if (!answers.length) return res.status(400).json({ ok: false, error: 'Answers required' });

    const q = await dbGet('SELECT id FROM project_questionnaires WHERE token = ?', [token]);
    if (!q) return res.status(404).json({ ok: false, error: 'Questionnaire not found' });

    await dbRun('INSERT INTO questionnaire_submissions (questionnaire_id, answers_json) VALUES (?, ?)', [q.id, JSON.stringify(answers)]);
    await dbRun(`UPDATE project_questionnaires SET status = 'completed' WHERE id = ?`, [q.id]);

    return res.json({ ok: true });
  } catch {
    return res.status(500).json({ ok: false, error: 'Could not submit questionnaire' });
  }
});

app.post('/api/admin/underwriting/decide', async (req, res) => {
  try {
    const admin = await requireAdmin(req, res);
    if (!admin) return;

    const userId = String(req.body?.userId || '').trim();
    const decision = String(req.body?.decision || '').trim();
    const approvedLimit = Number(req.body?.approvedLimit || 0);
    const reason = String(req.body?.reason || '').trim() || 'Manual underwriting decision';
    const reviewer = admin.email || 'admin';

    if (!userId || !['approved', 'declined', 'pending'].includes(decision)) {
      return res.status(400).json({ ok: false, error: 'Invalid decision payload' });
    }

    if (supabaseEnabled) {
      const { data: membership, error: mErr } = await supabaseAdmin
        .from('business_memberships')
        .select('*')
        .eq('user_id', userId)
        .order('id', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (mErr) throw mErr;
      if (!membership) return res.status(404).json({ ok: false, error: 'Membership not found' });

      const applicationId = membership.application_id || 0;

      const { error: uErr } = await supabaseAdmin.from('underwriting_decisions').insert({
        application_id: applicationId,
        user_id: userId,
        decision,
        approved_limit: Math.max(0, approvedLimit),
        reason,
        reviewer
      });
      if (uErr) throw uErr;

      if (decision === 'approved') {
        const { error: patchErr } = await supabaseAdmin
          .from('business_memberships')
          .update({ approved_limit: Math.max(0, approvedLimit), active_limit: 0, credit_limit_status: 'approved_not_active' })
          .eq('id', membership.id);
        if (patchErr) throw patchErr;
      } else if (decision === 'declined') {
        const { error: patchErr } = await supabaseAdmin
          .from('business_memberships')
          .update({ approved_limit: 0, active_limit: 0, credit_limit_status: 'declined' })
          .eq('id', membership.id);
        if (patchErr) throw patchErr;
      }

      return res.json({ ok: true });
    }

    const membership = await dbGet('SELECT * FROM business_memberships WHERE user_id = ? ORDER BY id DESC LIMIT 1', [Number(userId)]);
    if (!membership) return res.status(404).json({ ok: false, error: 'Membership not found' });

    const applicationId = membership.application_id || 0;

    await dbRun(
      `INSERT INTO underwriting_decisions (application_id, user_id, decision, approved_limit, reason, reviewer, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [applicationId, Number(userId), decision, Math.max(0, approvedLimit), reason, reviewer]
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

    await dbRun(
      `INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, payload_json)
       VALUES (?, 'underwriting_decision', 'user', ?, ?)`,
      [admin.adminUserId, String(userId), JSON.stringify({ decision, approvedLimit, reason })]
    );

    return res.json({ ok: true });
  } catch (error) {
    console.error('[underwriting] decision failed', error.message);
    return res.status(500).json({ ok: false, error: `Could not save decision (${error?.message || 'unknown'})` });
  }
});

app.get('/api/health', (req, res) => res.json({
  status: 'ok',
  service: 'Ventus',
  stripeConfigured: !!stripe,
  checkoutProducts: Object.keys(CHECKOUT_PRODUCTS).length,
  mappedPrices: Object.keys(STRIPE_PRICE_MAP || {}).length,
  beehiivConfigured: !!beehiivApiKey,
  supabaseEnabled,
  supabaseUrlValid
}));
app.get('*', (req, res) => res.sendFile(path.join(WEB_DIR, 'index.html')));

app.listen(PORT, () => console.log(`🚀 Ventus on port ${PORT}`));