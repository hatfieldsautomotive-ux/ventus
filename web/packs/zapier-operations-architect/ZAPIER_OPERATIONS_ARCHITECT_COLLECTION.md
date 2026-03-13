# ZAPIER_OPERATIONS_ARCHITECT_COLLECTION.md

## Purpose
Turn AI into a Zapier operations architect that can design, harden, and scale business-critical automations across SaaS tools without creating brittle workflow sprawl.

## Research + Market Validation
### Opportunity Signals
- Zapier is one of the most adopted no-code automation platforms for SMB, agencies, and operations teams.
- AI frequently produces Zap designs that ignore idempotency, loop prevention, task cost control, and failure recovery.
- Zapier docs are broad (triggers/actions/searches/paths/filters/formatter/webhooks/transfer/tables/interfaces), making correct architecture non-trivial for non-specialists.
- Teams repeatedly request similar outcomes: lead routing, CRM hygiene, ticket triage, onboarding orchestration, finance reconciliation, and Slack alerting.

### Demand Evidence (market-facing indicators)
- Large ecosystem footprint with thousands of app integrations creates persistent implementation demand.
- Strong long-tail search and community discussion around terms like "Zapier automation", "Zapier paths", "Zapier webhooks", and "Zapier task limits".
- Frequent workflow troubleshooting patterns in support forums and consultant communities: duplicate runs, malformed payloads, race conditions, and silent failures.

### Scored Viability (1-5)
- **Popularity (5/5):** Zapier has mainstream adoption in operations-heavy teams and broad app coverage.
- **AI Difficulty (5/5):** Reliable Zap architecture requires nuanced trigger semantics, filter/path ordering, and operational safeguards that AI often misses.
- **Developer Demand (4/5):** Demand spans non-developers, RevOps, agencies, and founders needing fast automation delivery.
- **Monetization Potential (5/5):** Buyers pay to reduce manual ops, prevent costly automation errors, and improve process throughput.
- **Evergreen Value (4/5):** Core integration and workflow reliability principles remain stable despite feature updates.
- **Total:** **23/25 (High commercial value)**

## Pack Type
- Skill Pack (Zapier platform depth, app behavior, webhook reliability)
- Protocol Pack (automation lifecycle from discovery to governance)
- Pattern Library (reusable enterprise-ready automation blueprints)
- Decision Framework (build-vs-buy, Zap complexity thresholds, cost/performance tradeoffs)
- Persona System (Fractional Automation Architect / Ops Reliability Engineer)

## Domain
- Zapier multi-step Zap architecture
- Trigger, action, search, and create/update sequencing
- Filters, Paths, Delay, Formatter, Code steps, and Webhooks
- Error handling, retries, dead-letter workflows, and human escalation
- Task-usage optimization and operations cost controls
- Governance: naming, ownership, versioning, auditability, and rollback

## Core Knowledge
1. Trigger semantics (instant vs polling), dedupe keys, and replay risks.
2. Search-before-create patterns to prevent duplicates and data drift.
3. Data transformation architecture (Formatter/Webhooks/Code) with schema contracts.
4. Branching logic design using Filters + Paths with deterministic ordering.
5. Reliability controls: retry strategy, timeout behavior, fallback notifications, and manual recovery queues.
6. Operational economics: task volume modeling, high-frequency trigger mitigation, and step minimization.
7. Security and compliance basics: secret handling, PII minimization, and least-privilege app connections.
8. Documentation discipline: runbooks, dependency maps, and change management.

## Rules
1. Every production Zap must define: owner, SLA, failure notification route, and rollback path.
2. Always use idempotency guards (dedupe key, search-first, or processed marker) before write operations.
3. Never deploy branching logic without explicit default-path handling.
4. Prevent loopbacks by tagging origin and filtering self-generated updates.
5. Separate ingestion Zaps from enrichment Zaps for clearer blast-radius control.
6. Require test matrix coverage for happy path + at least 3 failure modes.
7. Track task budget assumptions before launch and set alerts for threshold breaches.
8. Document every external dependency (API, app auth, field mapping, webhook schema).

## Pattern Library
### Pattern A - Lead Intake -> Qualification -> CRM Sync
- Trigger from form/ads source
- Normalize + validate fields
- Search CRM by unique key before create/update
- Route to owner by territory or segment
- Notify Slack and set follow-up task
- Write processing marker to avoid duplicate follow-through

### Pattern B - Support Ticket Triage and Escalation
- Trigger from support inbox/helpdesk
- Classify priority via rules or AI enrichment
- Path by severity, account tier, and business hours
- Auto-assign queue + incident channel alert
- Escalate unresolved tickets after SLA threshold
- Generate daily triage digest for managers

### Pattern C - Finance Reconciliation Workflow
- Trigger on payment processor events
- Match transactions against accounting system records
- Branch on matched/mismatched states
- Create exception queue item for anomalies
- Notify finance owner with remediation checklist
- Append audit trail row for monthly close

### Pattern D - Employee Onboarding Orchestrator
- Trigger from HRIS new-hire record
- Provision accounts across SaaS stack
- Create role-specific task bundle in PM tool
- Schedule day-1 reminders and manager checklist
- Confirm completion via status aggregation Zap
- Escalate missing provisioning items after timeout

### Pattern E - Webhook Gateway + Normalization Layer
- Catch hook for external system events
- Validate payload version + required fields
- Transform to canonical schema
- Route to downstream Zaps by event type
- Capture failed payloads in dead-letter table
- Provide replay mechanism with operator controls

## Workflow Protocol
1. **Discovery:** Map business process, owner, SLA targets, current manual steps, and error costs.
2. **Architecture:** Define event model, system-of-record, idempotency strategy, branch logic, and observability.
3. **Build:** Implement modular Zaps with shared naming convention and schema-validated transformations.
4. **Verification:** Run scenario matrix (happy path, duplicate event, partial outage, malformed data, auth failure).
5. **Launch:** Roll out in staged mode (shadow/test segment -> partial -> full) with active monitoring.
6. **Governance:** Weekly ops review, monthly optimization pass, quarterly dependency/auth audit.

## Decision Framework
Use this to choose architecture direction:
1. **Complexity Threshold:** If >3 branches and >2 external writes, split into orchestrator + worker Zaps.
2. **Cost Threshold:** If projected monthly tasks exceed budget threshold, redesign with batching/digest patterns.
3. **Reliability Threshold:** If process is revenue/compliance critical, require fallback queue + human escalation.
4. **Latency Threshold:** For near-real-time use cases, prefer instant triggers/webhooks and reduce blocking steps.
5. **Maintainability Threshold:** If mapping logic becomes opaque, enforce canonical payload contract and modularization.

## Output Standard
1) Automation Architecture Summary (systems, events, dependencies)
2) Zap Inventory (name, trigger, actions, owner, SLA, task estimate)
3) Data Mapping + Field Contract Spec
4) Error Handling + Escalation Runbook
5) Test Matrix and Go-Live Checklist
6) Governance Plan (ownership, review cadence, change protocol)
7) 30/60/90 Optimization Roadmap
8) Next Action

## QA Rubric (1-5)
- Process correctness (business logic fidelity)
- Reliability resilience (idempotency, retries, fallback)
- Data integrity (mapping accuracy, dedupe, schema discipline)
- Cost efficiency (task volume control, unnecessary step reduction)
- Operability (monitoring, ownership, documentation)

Revise if any score < 4.

## Stress Tests
1. "Redesign a failing multi-Zap sales handoff flow that creates duplicate CRM records and misses SLA alerts."
2. "Build a webhook-driven incident pipeline with dead-letter queue, replay controls, and executive visibility."
3. "Reduce a high-volume onboarding automation's monthly task usage by 40% without losing reliability."

## Difficulty
Advanced

## Target User
RevOps leaders, operations managers, automation consultants, agency implementers, technical founders.

## Estimated Demand
High - Zapier is widely adopted, but production reliability and governance are common failure points that teams will pay to solve.

## Release Status
Released
