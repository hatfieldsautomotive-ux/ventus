# Ventus -> Supabase Cutover Plan

## Goal
Replace SQLite auth/application persistence with Supabase so member/admin logins survive deploys and the app is launch-safe.

## Phase 1 (Launch-Critical)
1. Supabase project + keys configured in Render.
2. Create core tables in Supabase Postgres:
   - profiles (member/admin metadata)
   - studio_applications
   - business_memberships
   - verification_checks
   - underwriting_decisions
   - verification_evidence
   - addon_purchases
3. Move auth to Supabase Auth (email/password):
   - Member signup/login/logout/me
   - Admin login/logout/me (role in profiles table)
4. Update `/api/studio-application` write path to Supabase.
5. Keep Stripe webhooks and other APIs, but persist to Supabase.

## Phase 2 (Post-Launch Hardening)
1. Migrate questionnaire/project task/admin notes tables.
2. Add Row Level Security policies for all tables.
3. Add audit logging in Supabase.
4. Remove SQLite dependency fully.

## Required Environment Variables
- SUPABASE_URL
- SUPABASE_ANON_KEY
- SUPABASE_SERVICE_ROLE_KEY

## Cutover Strategy
- Deploy dual-write or one-way switch with feature flag:
  - `DATA_BACKEND=supabase` (default after validation)
- Keep legacy SQLite read-only fallback for 3-7 days.
- After validation, remove SQLite auth/session logic.

## Validation Checklist
- Member can sign up, log in, log out, and persist after redeploy.
- Admin can log in and access admin endpoints.
- New application submission creates linked membership + verification rows.
- Stripe webhook writes are persisted in Supabase.
- Redeploy does not affect existing accounts.
