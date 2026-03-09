const fs = require('fs');
const path = require('path');

const packs = [
  {
    slug: 'project-manager',
    file: 'PROJECT_MANAGER_COLLECTION.md',
    title: 'Project Manager Collection',
    role: 'Delivery-focused project manager',
    outcomes: ['Fewer missed deadlines', 'Clear ownership', 'Reduced project risk'],
    workflows: ['Project scoping', 'Milestone planning', 'RAID tracking', 'Delivery recovery plans']
  },
  {
    slug: 'executive-assistant',
    file: 'EXECUTIVE_ASSISTANT_COLLECTION.md',
    title: 'Executive Assistant Collection',
    role: 'Executive support operator',
    outcomes: ['Sharper priorities', 'Cleaner communication', 'Better meeting execution'],
    workflows: ['Inbox triage', 'Daily briefing', 'Meeting prep', 'Follow-up tracking']
  },
  {
    slug: 'customer-success',
    file: 'CUSTOMER_SUCCESS_COLLECTION.md',
    title: 'Customer Success Collection',
    role: 'Retention and expansion strategist',
    outcomes: ['Lower churn', 'Stronger onboarding', 'Higher expansion opportunities'],
    workflows: ['Onboarding playbooks', 'Health scoring', 'Renewal handling', 'Churn rescue']
  },
  {
    slug: 'recruiting-operator',
    file: 'RECRUITING_OPERATOR_COLLECTION.md',
    title: 'Recruiting Operator Collection',
    role: 'Hiring operations partner',
    outcomes: ['Faster hiring cycles', 'Better candidate quality', 'Consistent interview process'],
    workflows: ['Role scorecards', 'Interview loops', 'Candidate evaluation', 'Offer process']
  },
  {
    slug: 'closer-call-scripts',
    file: 'CLOSER_CALL_SCRIPTS_COLLECTION.md',
    title: 'Closer Call Scripts Collection',
    role: 'High-trust sales call strategist',
    outcomes: ['Higher close rates', 'Better objection handling', 'Improved call quality'],
    workflows: ['Discovery scripting', 'Objection trees', 'Close frameworks', 'Post-call follow-up']
  },
  {
    slug: 'linkedin-authority',
    file: 'LINKEDIN_AUTHORITY_COLLECTION.md',
    title: 'LinkedIn Authority Collection',
    role: 'LinkedIn thought leadership operator',
    outcomes: ['Stronger authority positioning', 'Higher engagement quality', 'Lead-generating content flow'],
    workflows: ['Content pillars', 'Post cadence', 'Comment strategy', 'Authority narrative arc']
  },
  {
    slug: 'youtube-growth',
    file: 'YOUTUBE_GROWTH_COLLECTION.md',
    title: 'YouTube Growth Collection',
    role: 'Video growth strategist',
    outcomes: ['Higher retention', 'Better click-through', 'Consistent channel growth'],
    workflows: ['Topic planning', 'Script structure', 'Title packaging', 'Retention optimization']
  },
  {
    slug: 'newsletter-engine',
    file: 'NEWSLETTER_ENGINE_COLLECTION.md',
    title: 'Newsletter Engine Collection',
    role: 'Newsletter production system',
    outcomes: ['Consistent publication', 'Improved reader engagement', 'Monetization-ready format'],
    workflows: ['Editorial planning', 'Issue templates', 'CTA strategy', 'Performance review']
  },
  {
    slug: 'paid-ads-creative',
    file: 'PAID_ADS_CREATIVE_COLLECTION.md',
    title: 'Paid Ads Creative Collection',
    role: 'Paid creative testing strategist',
    outcomes: ['More ad winners', 'Lower creative fatigue', 'Faster optimization cycles'],
    workflows: ['Angle generation', 'Creative matrix', 'Testing protocol', 'Iteration loop']
  },
  {
    slug: 'brand-voice',
    file: 'BRAND_VOICE_COLLECTION.md',
    title: 'Brand Voice Collection',
    role: 'Brand language guardian',
    outcomes: ['Consistent messaging', 'Clear brand differentiation', 'Higher trust in communication'],
    workflows: ['Voice calibration', 'Style constraints', 'Rewrite protocol', 'Voice QA']
  }
];

function buildPack(p) {
  return `# ${p.file}

## Purpose
Turn AI into a ${p.role} that can execute production-grade workflows with repeatable standards.

## Domain
${p.workflows.map(w => `- ${w}`).join('\n')}

## Core Knowledge
- Objective and audience alignment before execution
- Domain-specific constraints and quality standards
- Prioritization under limited resources
- Risk and tradeoff communication
- Iterative improvement principles

## Rules
1. Clarify outcome, constraints, and success metric first.
2. Avoid generic output; use specific, implementable recommendations.
3. Surface assumptions explicitly.
4. Include owners, sequence, and checkpoints.
5. Provide one immediate next action.

## Patterns
### Pattern A — Diagnose → Plan → Execute
- Diagnose current state
- Plan target-state approach
- Execute with checks

### Pattern B — Draft → QA → Upgrade
- Create first draft
- Score against rubric
- Revise weak areas

### Pattern C — Weekly Improvement Loop
- Review outcomes
- Identify one bottleneck
- Ship one improvement

## Workflow
1. Intake context and objective.
2. Run domain-specific diagnostic prompts.
3. Generate structured strategy/output.
4. Add implementation steps and ownership.
5. Run QA rubric and revise.
6. Deliver final recommendation + next action.

## Output Standard
1) Executive Summary
2) Structured Recommendation
3) Implementation Plan
4) Risks + Mitigations
5) QA Checklist
6) Next Action

## QA Rubric (1-5)
- Clarity
- Specificity
- Practicality
- Risk-awareness
- Actionability

If any score is below 4, revise before final delivery.

## Expected Outcomes
${p.outcomes.map(o => `- ${o}`).join('\n')}

## Stress Tests
- Produce output from incomplete context with minimal clarifying questions.
- Create a 7-day execution plan with clear owner checkpoints.
- Detect and flag contradictions in requested outcomes.

## Difficulty
Advanced

## Target User
Founders, operators, marketing teams, and specialists.

## Release Status
Phase 3b — Release-ready depth
`;
}

for (const p of packs) {
  const webPath = path.join('web', 'packs', p.slug, p.file);
  const reviewPath = path.join('review', 'packs', p.slug, p.file);
  fs.mkdirSync(path.dirname(webPath), { recursive: true });
  fs.mkdirSync(path.dirname(reviewPath), { recursive: true });
  const content = buildPack(p);
  fs.writeFileSync(webPath, content, 'utf8');
  fs.writeFileSync(reviewPath, content, 'utf8');
}

console.log(`Phase 3b upgraded ${packs.length} packs.`);
