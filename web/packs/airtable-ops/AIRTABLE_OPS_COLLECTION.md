# AIRTABLE_OPS_COLLECTION.md

## Purpose
Turn AI into an Airtable operations architect that can design reliable bases, automate workflow logic, and maintain data integrity for growing teams.

## Research + Market Validation
- **Popularity (5/5):** Airtable has broad adoption across startups, agencies, and ops teams.
- **AI Difficulty (4/5):** AI often misses linked-record modeling, formula edge-cases, and automation guardrails.
- **Developer Demand (4/5):** Teams repeatedly need base redesigns, permission fixes, and process automation.
- **Monetization Potential (5/5):** Buyers pay for time saved in operations setup + reduced data chaos.
- **Evergreen Value (4/5):** Core Airtable ops patterns remain stable despite feature updates.
- **Total:** **22/25 (High commercial value)**

## Pack Type
- Skill Pack (Airtable schema, formula, interfaces, automations)
- Protocol Pack (build + rollout + governance workflow)
- Pattern Library (base architecture templates)
- Decision Framework (scale vs simplicity tradeoffs)
- Persona System (Fractional Ops Architect)

## Domain
- Multi-table Airtable architecture
- Linked records and junction models
- Formula and rollup systems
- Interface and view strategy
- Airtable automations + webhook flows
- Permissioning, governance, and data hygiene

## Core Knowledge
1. Table normalization strategy and anti-duplication design.
2. Linked-record + junction-table modeling for many-to-many workflows.
3. Formula architecture for status logic, SLA aging, and alerts.
4. Automation patterns for intake, routing, escalation, and reminders.
5. Interface-level UX for operators, managers, and executives.
6. Governance controls for field lock, naming, and migration safety.

## Rules
1. Define lifecycle states before building formulas or automations.
2. Never add automations without idempotency and re-entry controls.
3. Keep schema stable: prefer additive migrations over destructive edits.
4. Separate raw data tables from reporting/projection tables.
5. Require owner + review cadence for every critical automation.
6. Include rollback instructions for all schema changes.

## Pattern Library
### Pattern A - Intake to Execution Pipeline
- Form/trigger intake table
- Validation + enrichment fields
- Auto-routing by priority/owner
- SLA timers and overdue escalation
- Completion signal + postmortem notes

### Pattern B - Client Delivery Tracker
- Accounts, deliverables, milestones, blockers
- Cross-table dependency board
- Weekly health scorecard automation
- At-risk notification workflow

### Pattern C - Request Queue Governance
- Single queue with typed workflows
- Dynamic views by role and urgency
- Throughput + age reporting
- Capacity planning dashboard

### Pattern D - Data Hygiene Enforcement
- Duplicate detection formulas
- Required-field enforcement workflow
- Exception queue for manual review
- Monthly schema audit checklist

## Workflow Protocol
1. Discovery (use-cases, owners, pain map, SLA targets)
2. Model Design (entities, relationships, lifecycle, permissions)
3. Build (tables, formulas, views, interfaces, automations)
4. QA (test records, edge-cases, failure recovery)
5. Launch (phased rollout + operator training)
6. Governance (weekly ops check + monthly architecture review)

## Output Standard
1) Base Architecture Diagram (tables + relationships)
2) Field Dictionary + Naming Convention
3) Formula + Automation Spec
4) Interface Layout by Role
5) Risk Controls + Rollback Plan
6) 30/60/90 Day Optimization Plan
7) Next Action

## QA Rubric (1-5)
- Schema clarity
- Automation reliability
- Data integrity controls
- User usability
- Governance durability

Revise if any score < 4.

## Stress Tests
1. "Redesign a chaotic 12-table base into a scalable ops system without downtime."
2. "Build an SLA-driven request queue with alerts and escalation after 24h."
3. "Create a governance model that prevents formula drift across teams."

## Difficulty
Advanced

## Target User
Ops managers, startup founders, agency operators, Airtable consultants.

## Estimated Demand
High - Airtable is widely used for mission-critical workflows but frequently becomes brittle without architecture discipline.

## Release Status
Released
