-- Ventus launch schema (Supabase/Postgres)
-- Run in Supabase SQL editor.

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique not null,
  role text not null default 'member' check (role in ('member','admin','owner')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.studio_applications (
  id bigserial primary key,
  user_id uuid references public.profiles(id) on delete set null,
  business_legal_name text not null,
  dba text,
  ein text not null,
  entity_type text,
  contact_name text not null,
  email text not null,
  phone text,
  package_interest text,
  website_url text,
  monthly_revenue_band text,
  services_needed text,
  consent_terms boolean not null default false,
  consent_reporting boolean not null default false,
  raw_json jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.business_memberships (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  application_id bigint references public.studio_applications(id) on delete set null,
  business_name text,
  plan text,
  membership_status text not null default 'pending_payment',
  credit_limit_status text not null default 'verification_pending',
  approved_limit integer not null default 0,
  active_limit integer not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.verification_checks (
  id bigserial primary key,
  application_id bigint not null references public.studio_applications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null default 'manual_rules_v1',
  status text not null default 'pending',
  score integer not null default 0,
  notes text,
  ein_valid boolean not null default false,
  email_domain_match boolean not null default false,
  business_name_present boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.underwriting_decisions (
  id bigserial primary key,
  application_id bigint not null references public.studio_applications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  decision text not null default 'pending',
  approved_limit integer not null default 0,
  reason text,
  reviewer text default 'system',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.verification_evidence (
  id bigserial primary key,
  application_id bigint not null references public.studio_applications(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  ein_letter_provided boolean not null default false,
  formation_doc_provided boolean not null default false,
  bank_proof_provided boolean not null default false,
  evidence_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.addon_purchases (
  id bigserial primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  addon_key text not null,
  amount_cents integer not null,
  stripe_session_id text,
  status text not null default 'paid',
  created_at timestamptz not null default now()
);

create index if not exists idx_studio_applications_email on public.studio_applications(email);
create index if not exists idx_business_memberships_user_id on public.business_memberships(user_id);
create index if not exists idx_verification_checks_user_id on public.verification_checks(user_id);
create index if not exists idx_underwriting_decisions_user_id on public.underwriting_decisions(user_id);

-- Basic RLS (tighten post-launch as needed)
alter table public.profiles enable row level security;
alter table public.studio_applications enable row level security;
alter table public.business_memberships enable row level security;
alter table public.verification_checks enable row level security;
alter table public.underwriting_decisions enable row level security;
alter table public.verification_evidence enable row level security;
alter table public.addon_purchases enable row level security;

-- Members can read/write their own profile and related records.
drop policy if exists profiles_self on public.profiles;
create policy profiles_self on public.profiles for select using (auth.uid() = id);

drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update using (auth.uid() = id);

drop policy if exists apps_self on public.studio_applications;
create policy apps_self on public.studio_applications for select using (auth.uid() = user_id);

drop policy if exists apps_self_insert on public.studio_applications;
create policy apps_self_insert on public.studio_applications for insert with check (auth.uid() = user_id);

drop policy if exists memberships_self on public.business_memberships;
create policy memberships_self on public.business_memberships for select using (auth.uid() = user_id);

drop policy if exists verifications_self on public.verification_checks;
create policy verifications_self on public.verification_checks for select using (auth.uid() = user_id);

drop policy if exists underwriting_self on public.underwriting_decisions;
create policy underwriting_self on public.underwriting_decisions for select using (auth.uid() = user_id);

drop policy if exists evidence_self_rw on public.verification_evidence;
create policy evidence_self_rw on public.verification_evidence for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists addons_self on public.addon_purchases;
create policy addons_self on public.addon_purchases for select using (auth.uid() = user_id);
