const fs = require('fs');
const path = require('path');

const packs = [
  ['developer-copilot','DEVELOPER_COPILOT_COLLECTION','Turn AI into a senior software copilot for planning, implementation, and code quality.','Software engineering, refactoring, review, architecture',['Refactor legacy module safely','Generate implementation plan from ticket','Produce review checklist']],
  ['no-code-automation','NO_CODE_AUTOMATION_COLLECTION','Turn AI into an automation designer for Zapier/Make workflows and ops automation.','No-code automation, triggers/actions, ops workflows',['Design lead routing automation','Build invoice reminder flow','Create error retry logic']],
  ['market-intelligence','MARKET_INTELLIGENCE_COLLECTION','Turn AI into a competitor and market intelligence analyst for strategic positioning.','Competitor analysis, pricing intel, trend mapping',['Compare 5 competitors','Build positioning gap map','Generate strategic memo']],
  ['landing-page-conversion','LANDING_PAGE_CONVERSION_COLLECTION','Turn AI into a conversion-focused landing page strategist and copy architect.','CRO, messaging hierarchy, CTA strategy',['Rewrite low-converting hero','Build section order for offer','Create A/B test matrix']],
  ['prompt-qa','PROMPT_QA_COLLECTION','Turn AI into a prompt quality assurance system for reliability and consistency.','Prompt evaluation, hallucination control, test harnesses',['Score prompt quality','Add safety constraints','Build regression prompt suite']],
  ['project-manager','PROJECT_MANAGER_COLLECTION','Turn AI into a project manager for planning, risk tracking, and delivery cadence.','Project planning, milestone tracking, risk logs',['Create 4-week plan','Build RAID log','Recover slipped timeline']],
  ['executive-assistant','EXECUTIVE_ASSISTANT_COLLECTION','Turn AI into an executive assistant for prioritization, communication, and scheduling support.','Exec support, briefings, inbox triage',['Daily brief from notes','Draft priority email','Meeting prep packet']],
  ['customer-success','CUSTOMER_SUCCESS_COLLECTION','Turn AI into a customer success operator focused on retention and expansion.','Onboarding, churn prevention, renewal strategy',['Design onboarding sequence','Create churn rescue playbook','Build renewal script']],
  ['recruiting-operator','RECRUITING_OPERATOR_COLLECTION','Turn AI into a recruiting operator for sourcing, interviewing, and candidate evaluation.','Hiring workflows, scorecards, interview design',['Create scorecard','Draft interview loop','Build rejection/offer templates']],
  ['closer-call-scripts','CLOSER_CALL_SCRIPTS_COLLECTION','Turn AI into a closer-call script engine for high-trust sales conversations.','Sales calls, objection handling, close strategy',['Build discovery script','Handle budget objection','Post-call follow-up']],
  ['linkedin-authority','LINKEDIN_AUTHORITY_COLLECTION','Turn AI into a LinkedIn authority content system for thought leadership growth.','LinkedIn content strategy, hooks, cadence',['Create 14-day content plan','Rewrite post for authority tone','Comment strategy']],
  ['youtube-growth','YOUTUBE_GROWTH_COLLECTION','Turn AI into a YouTube growth strategist for retention, scripting, and packaging.','Video strategy, title/thumbnail logic, retention',['Write retention-first outline','Generate title variants','Build posting cadence']],
  ['newsletter-engine','NEWSLETTER_ENGINE_COLLECTION','Turn AI into a newsletter production engine for consistent, high-value issues.','Editorial systems, newsletter monetization, CTA design',['Issue template','4-week calendar','Monetization placement strategy']],
  ['paid-ads-creative','PAID_ADS_CREATIVE_COLLECTION','Turn AI into a paid ads creative strategist for angles, variants, and testing.','Paid social creative, testing matrix, offers',['Generate 10 ad angles','Build test matrix','Diagnose underperforming ad']],
  ['brand-voice','BRAND_VOICE_COLLECTION','Turn AI into a brand voice guardian for consistent messaging across channels.','Voice calibration, tone controls, style guides',['Create voice guide','Rewrite generic copy','Build do and dont bank']],
  ['ai-agent-builder','AI_AGENT_BUILDER_COLLECTION','Turn AI into an agent systems architect for role design and tool orchestration.','Agent design, memory, tool routing, fallback logic',['Define multi-agent roles','Build failure handling','Create tool policy']],
  ['due-diligence','DUE_DILIGENCE_COLLECTION','Turn AI into a due diligence analyst for risk discovery and decision support.','Risk analysis, investment checks, audit questions',['Build diligence checklist','Identify red flags','Create summary memo']],
  ['policy-compliance','POLICY_COMPLIANCE_COLLECTION','Turn AI into a policy/compliance assistant for control mapping and audits.','Policies, controls, compliance workflows',['Map controls to policy','Draft audit prep','Create compliance gap report']],
  ['learning-accelerator','LEARNING_ACCELERATOR_COLLECTION','Turn AI into a learning accelerator for structured skill acquisition.','Learning plans, spaced repetition, practice loops',['Create 30-day plan','Build practice drills','Weekly mastery review']]
];

function template(title, purpose, domain, tests) {
  return `# ${title}.md

## Purpose
${purpose}

---

## Domain
${domain}

---

## Core Knowledge
- First principles of the domain
- Common failure patterns
- Decision criteria and tradeoffs
- Execution standards and QA gates

---

## Rules
1. Clarify objective before producing output.
2. Prefer specific recommendations over generic advice.
3. Include assumptions and risks.
4. Define owner/action/next step whenever relevant.
5. Add quality checks before final output.

---

## Patterns
### Pattern 1 — Objective → Plan
- Goal
- Constraints
- Strategy
- Execution

### Pattern 2 — Draft → Review → Improve
- Produce first pass
- Evaluate against quality rubric
- Revise for clarity and impact

### Pattern 3 — Weekly Optimization Loop
- Measure outcomes
- Identify bottlenecks
- Improve one system component

---

## Workflow
1. Define objective + context.
2. Select relevant pattern.
3. Produce structured output.
4. Run quality checks.
5. Provide next action.

---

## Output Standard
- Executive summary
- Structured recommendation
- Implementation steps
- Risks/assumptions
- Immediate next action

---

## Stress Tests
- ${tests[0]}
- ${tests[1]}
- ${tests[2]}

---

## Difficulty
Intermediate to Advanced

## Target User
Operators, founders, teams, specialists

## Estimated Demand
Moderate to High
`;
}

for (const [slug, title, purpose, domain, tests] of packs) {
  const dir = path.join('web', 'packs', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${title}.md`), template(title, purpose, domain, tests));
}

console.log(`Generated ${packs.length} collection files.`);
