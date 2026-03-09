const fs = require('fs');
const path = require('path');

const packs = [
  {
    slug: 'sales-strategist',
    file: 'SALES_STRATEGIST_COLLECTION.md',
    title: 'Sales Strategist Collection',
    role: 'Revenue-focused sales strategist',
    outcomes: ['Higher qualified call rates', 'Better close quality', 'Shorter sales cycles'],
    workflows: ['Offer positioning sprint', 'Discovery script build', 'Objection matrix and rebuttal system', 'Follow-up sequence optimization']
  },
  {
    slug: 'app-architect',
    file: 'APP_ARCHITECT_COLLECTION.md',
    title: 'App Architect Collection',
    role: 'Product and architecture planner',
    outcomes: ['Clear MVP scope', 'Fewer engineering rewrites', 'Faster implementation start'],
    workflows: ['MVP cutline', 'Feature decomposition', 'API/data contract drafting', 'Build sequence roadmap']
  },
  {
    slug: 'content-studio',
    file: 'CONTENT_STUDIO_COLLECTION.md',
    title: 'Content Studio Collection',
    role: 'Editorial and distribution system designer',
    outcomes: ['Consistent content cadence', 'Higher quality messaging', 'Cross-channel reuse'],
    workflows: ['Content brief generation', 'Editorial calendar', 'Repurposing ladder', 'Performance iteration loop']
  },
  {
    slug: 'research-engine',
    file: 'RESEARCH_ENGINE_COLLECTION.md',
    title: 'Research Engine Collection',
    role: 'Structured research analyst',
    outcomes: ['Decision-ready synthesis', 'Clear confidence framing', 'Reduced analysis noise'],
    workflows: ['Research brief', 'Evidence matrix', 'Option comparison', 'Decision memo']
  },
  {
    slug: 'developer-copilot',
    file: 'DEVELOPER_COPILOT_COLLECTION.md',
    title: 'Developer Copilot Collection',
    role: 'Senior engineering copilot',
    outcomes: ['Better implementation quality', 'Cleaner reviews', 'Fewer regressions'],
    workflows: ['Implementation planning', 'Refactor protocol', 'Code review checklist', 'Test coverage planning']
  },
  {
    slug: 'landing-page-conversion',
    file: 'LANDING_PAGE_CONVERSION_COLLECTION.md',
    title: 'Landing Page Conversion Collection',
    role: 'CRO and messaging architect',
    outcomes: ['Improved CVR', 'Clearer value proposition', 'Stronger CTA performance'],
    workflows: ['Message hierarchy design', 'Section order optimization', 'Offer/CTA alignment', 'A/B test matrix']
  },
  {
    slug: 'ai-agent-builder',
    file: 'AI_AGENT_BUILDER_COLLECTION.md',
    title: 'AI Agent Builder Collection',
    role: 'Agent systems architect',
    outcomes: ['Reliable agent behavior', 'Cleaner tool routing', 'Safer failure handling'],
    workflows: ['Role and tool policy', 'Memory and context strategy', 'Fallback design', 'Agent QA harness']
  },
  {
    slug: 'prompt-qa',
    file: 'PROMPT_QA_COLLECTION.md',
    title: 'Prompt QA Collection',
    role: 'Prompt reliability engineer',
    outcomes: ['Lower hallucination risk', 'Higher output consistency', 'Faster prompt iteration'],
    workflows: ['Prompt rubric scoring', 'Regression test suite', 'Failure-mode patching', 'Version control practices']
  },
  {
    slug: 'market-intelligence',
    file: 'MARKET_INTELLIGENCE_COLLECTION.md',
    title: 'Market Intelligence Collection',
    role: 'Competitive intelligence operator',
    outcomes: ['Sharper positioning', 'Faster market insight', 'Better strategic timing'],
    workflows: ['Competitor matrix', 'Feature/pricing comparisons', 'Gap opportunity analysis', 'Strategic recommendation brief']
  },
  {
    slug: 'no-code-automation',
    file: 'NO_CODE_AUTOMATION_COLLECTION.md',
    title: 'No-Code Automation Collection',
    role: 'Automation workflow engineer',
    outcomes: ['Reduced manual ops', 'Fewer handoff errors', 'Higher execution speed'],
    workflows: ['Workflow mapping', 'Trigger/action logic', 'Error and retry handling', 'Operational monitoring']
  }
];

function buildPack(p) {
  return `# ${p.file}

## Purpose
Turn AI into a ${p.role} that can execute production-grade workflows with repeatable standards.

## Domain
${p.workflows.map(w => `- ${w}`).join('\n')}

## Core Knowledge
- Business objective mapping before execution
- Constraint-aware recommendations
- Risk and tradeoff communication
- Output quality standards and acceptance criteria
- Iterative optimization loops

## Rules
1. Clarify objective, constraints, and success metric first.
2. Never output generic advice when concrete actions are possible.
3. Include assumptions and confidence level on key recommendations.
4. Every plan must have owners, sequence, and verification checks.
5. Every final output must end with one immediate next action.

## Patterns
### Pattern A — Diagnose → Design → Deliver
- Diagnose current state
- Design target-state system
- Deliver actionable implementation plan

### Pattern B — Draft → QA → Revise
- Generate first pass
- Score against rubric
- Rewrite weak sections

### Pattern C — Weekly Improvement Loop
- Measure outcomes
- Identify bottleneck
- Ship one improvement

## Workflow
1. Intake objective and context.
2. Run domain-specific diagnostic questions.
3. Produce structured recommendations.
4. Build implementation assets.
5. Run QA rubric and revise.
6. Deliver final package with next-step action.

## Output Standard
For every major response, output in this structure:
1) Executive Summary
2) System Recommendation
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
- Handle incomplete context by asking the minimum critical clarifying questions.
- Produce a plan that can be executed in under 7 days.
- Detect and flag contradiction/risk in user goals.

## Difficulty
Advanced

## Target User
Founders, operators, builders, and specialists needing repeatable high-quality AI output.

## Release Status
Phase 3 — Release-ready depth
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

console.log(`Phase 3 upgraded ${packs.length} packs.`);
