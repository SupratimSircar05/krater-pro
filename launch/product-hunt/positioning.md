# Krater Pro positioning and acquisition plan

## Positioning in one sentence

For developers who want an agentic coding workflow without surrendering project
control or model choice, Krater Pro is a local CLI and browser IDE powered by
one tool-using agent, with auditable cost-aware routing, exact model overrides,
and explicit trust boundaries.

## Category

**Primary:** Agentic coding workspace
**Wedge:** One local agent across terminal and browser IDE
**Expansion:** Model-routing and workflow infrastructure for Krater-powered
software development

Krater Pro should not market itself as a generic chatbot, a hosted cloud IDE, a
benchmark champion, or an official Krater client.

## Ideal customer profiles

| Segment | Trigger | Core problem | Message | First CTA |
| --- | --- | --- | --- | --- |
| Independent developers | Juggling terminal agents and editor windows | Context and controls fracture across tools | One agent and project context in CLI + IDE | Try the Cloud Lab, then install locally |
| Cost-aware AI power users | Model bills rise or one model underperforms across tasks | Manual model selection is repetitive and opaque | Let an auditable router choose, or pin an exact model | Inspect an Auto routing decision |
| Polyglot teams | Work spans several languages and build systems | Generic prompts miss ecosystem conventions | Load only the relevant one of 40+ playbooks | Run a repository-mapping task |
| Security-conscious developers | Agent requests broad filesystem or command access | Tool autonomy is hard to audit | Workspace confinement, bounded commands, and visible approvals | Review the security model |
| Krater API users | Want a coding-specific interface for available models | Raw API access lacks an integrated coding workflow | Bring your own Krater key to a purpose-built local agent | Configure a key and pin Kimi K3 |

The initial ICP is the independent developer or small technical team already
comfortable with a terminal, Git, and API keys. Cloud Lab lowers evaluation
friction but must not pretend to replace the local product.

## Jobs to be done

1. “When I start a coding task, help me pick an appropriate model without
   making cost and capability a black box.”
2. “When I move between terminal and editor, keep the same agent, project, and
   approval context.”
3. “When an agent proposes a change or command, show me what it wants to do and
   keep it inside the selected workspace.”
4. “When I change languages or repositories, supply relevant expert guidance
   without spending tokens on every possible ecosystem.”
5. “When I evaluate the product, let me explore safely before granting local
   repository access or configuring paid inference.”

## Value proposition hierarchy

### Functional value

- One tool-using agent in a first-class CLI and integrated browser IDE.
- Fast switching among existing local folders, isolated public GitHub clones,
  and disposable scratch workspaces.
- Smart Routing based on task requirements, live catalog metadata, and
  provider-reported pricing.
- Exact model control, including `moonshotai/kimi-k3`.
- Conflict-aware editing, bounded command execution, Git inspection, and
  explicit approvals.
- Progressive 40+ language/ecosystem playbooks plus token and cache controls.

### Emotional value

- **Clarity:** see which model was selected and why.
- **Control:** know which project is active and approve protected actions.
- **Confidence:** distinguish verified harness behavior from unproven benchmark
  performance.
- **Continuity:** use terminal or browser without changing the underlying agent.

### Economic value

The router and context controls are designed to reduce unnecessary token use
and avoid paying for more model capability than the task appears to require.
This is a design objective, not a guaranteed savings percentage.

## Differentiators and proof

| Differentiator | What to say | Available evidence | Do not claim |
| --- | --- | --- | --- |
| CLI + IDE continuity | “The same agent/session powers both interfaces.” | Shared `AgentSession`, selected project, approvals, and streamed tool activity | “Replaces every IDE” |
| Smart Coding Router | “Cost-aware, capability-gated, and auditable.” | Live model metadata, quality target, Pareto frontier, visible rationale | “Always picks the cheapest successful model” |
| Project switching | “Local, public GitHub, or scratch in one selector.” | Project-scoped sessions and isolated clone/scratch roots | Private GitHub support |
| Exact model override | “Auto when you want help; exact IDs when you do not.” | Hard override and validated `moonshotai/kimi-k3` flow | Access to models outside the user's account |
| Efficient context | “Load skills progressively and bound retained output.” | Repository maps, result reuse, compaction, token budgets and telemetry | A fabricated percentage saving |
| Language depth | “40+ language and ecosystem playbooks.” | Checked-in reference files and routing skill | Compiler/LSP coverage for every language |
| Approval and confinement | “Visible approvals and workspace-scoped operations.” | Secret guards, atomic writes, time/output limits, macOS OS confinement | Perfect sandboxing on every platform |
| Evaluation honesty | “A strict 100-task catalog and public adapter status.” | Offline validation and checked-in benchmark status | All 100 tasks solved or all official suites passed |
| Cloud evaluation path | “Accounts and saved progress in a bounded virtual lab.” | D1-backed account/progress implementation and production QA | Remote shell, repository execution, or maintainer-key inference |

## Messaging pillars

### 1. One agent, two native workflows

**Headline:** Your terminal and IDE should not be separate AI silos.
**Proof point:** The project, conversation, approvals, and model decision remain
coherent across CLI and browser views.
**Demo moment:** Start a task in Chat, inspect the changed file in the IDE, then
show the Git diff.

### 2. Route intelligently, override instantly

**Headline:** Spend model capability where the task needs it.
**Proof point:** Auto mode explains the chosen model, tier, confidence, catalog
source, and rationale; exact model IDs bypass routing.
**Demo moment:** Compare an Auto decision with a pinned
`moonshotai/kimi-k3` task.

### 3. Agentic does not have to mean opaque

**Headline:** See the project, proposed action, and resource usage.
**Proof point:** Protected actions require approval; paths, output, session
tokens, and commands are bounded.
**Demo moment:** Show an approval card and a rejected protected-secret read.

### 4. Try safely, graduate locally

**Headline:** Explore in a virtual lab; do real coding on your machine.
**Proof point:** Cloud Lab saves bounded virtual progress but has no shell or
repository execution. Local Krater Pro handles real work with the user's key.
**Demo moment:** Save a virtual file, refresh, then show the local installation
path.

## Objections

**“It depends on one provider.”**
Krater Pro is purpose-built for the Krater API and does not pretend to be a
provider-neutral gateway. The benefit is a focused integration with the live
Krater model catalog; the tradeoff should be stated plainly.

**“BYOK is too much setup.”**
It is one more onboarding step, but it keeps provider access and billing under
the user's control. Cloud Lab should make the product understandable before
asking for a key.

**“The browser IDE is not VS Code.”**
Correct. It focuses on agent collaboration, text editing, bounded commands,
and Git inspection. It does not claim an LSP, debugger, extension marketplace,
or interactive PTY.

**“Why trust a coding benchmark from the product maker?”**
Do not ask for blind trust. Publish fixtures, checkers, adapter code, observed
failures, and resource gates. Treat official evaluator results as the authority.

## Acquisition journey

```text
Product Hunt / GitHub / technical content
                    ↓
            Cloud Lab product tour
                    ↓
       Account + saved virtual progress
                    ↓
      Official Krater.ai API-key handoff
                    ↓
       Local install + first real task
                    ↓
       Repeat use + issue/discussion
```

Each transition must be measurable without collecting source code, prompts, API
keys, or other sensitive content. Prefer anonymous aggregate events and clear
consent over invasive analytics.

## Launch plan

### Gate 0 — evidence before exposure

- Complete production Cloud Lab QA and the secret guard.
- Verify account isolation and persistence with two independent test accounts.
- Use a disposable visitor-owned Krater key to verify live Kimi K3, then confirm
  it is absent from D1, logs, cookies, assets, and error responses.
- Publish the exact release commit and keep `.env` and generated result
  artifacts out of Git.
- Confirm every public statement against the release documentation.

### Phase 1 — warm-up, 7–14 days

- Finish the maker's Product Hunt profile and participate genuinely in relevant
  discussions before launch.
- Publish a short technical article: “How a cost/capability Pareto router picks
  a coding model.”
- Record a 60–90 second silent-caption demo: project switch → Auto route →
  approval → edit → Git diff.
- Invite 5–10 relevant peers to test the product, asking for product feedback
  rather than launch-day votes.
- Turn blocking feedback into public issues and release notes.

### Phase 2 — launch day

- Publish only after final QA; self-hunt from the maker's personal account.
- Use the recommended tagline and all three gallery assets.
- Post the first maker comment immediately and answer each substantive comment
  personally.
- Share the direct launch URL organically on LinkedIn, X, and communities where
  the maker already participates.
- Publish the GitHub release and pin a “Start here” discussion with installation
  and security boundaries.
- Track questions by theme: onboarding, routing, IDE, security, model access,
  and price. Update the FAQ rather than repeating answers.

Product Hunt recommends a 240×240 thumbnail, 1270×760 gallery images, a personal
maker account, and organic sharing. It prohibits vote manipulation and
incentivized upvotes. Sources:
[posting guide](https://help.producthunt.com/en/articles/479557-how-to-post-a-product),
[sharing guide](https://help.producthunt.com/en/articles/2690626-how-do-i-share-my-post).

### Phase 3 — first 30 days

- Ship a weekly “router decision of the week” teardown with inputs, decision,
  tradeoff, and no private prompt data.
- Convert common setup failures into one-command diagnostics and documentation.
- Publish honest benchmark engineering notes: harness changes, official
  evaluator outcomes, failures, and next hypotheses.
- Create short language-specific examples from the checked-in playbooks.
- Invite useful issue authors into roadmap discussions; credit contributions.
- Add a public changelog and use releases—not marketing superlatives—to sustain
  attention.

### Phase 4 — durable growth loops

1. **Transparent routing loop:** more task feedback → better heuristics → clearer
   routing explanations → more trust and usage.
2. **Playbook loop:** ecosystem requests → reviewed playbooks → more credible
   language coverage → more contributors.
3. **Evaluation loop:** public failure → focused fix → official rerun → stronger
   evidence.
4. **Template loop:** useful scratch workflows → shareable, non-secret examples
   → easier first success.

Do not turn any loop into spam, coordinated voting, or undisclosed telemetry.

## Content backlog

- “Why a model router should expose its rejection reasons”
- “The difference between a benchmark harness pass and a solved task”
- “How conflict-aware agent edits avoid overwriting dirty tabs”
- “BYOK without leaking the provider key”
- “Progressive language skills: useful context without the token dump”
- “What macOS command confinement protects—and what it does not”
- “Local, GitHub clone, or scratch: choosing the right agent workspace”
- “A postmortem of an incomplete model stream”

Each article should link to code or evidence, include limitations, and end with
one concrete feedback question.

## Funnel metrics

These are metric definitions, not current results or forecasts.

| Stage | Metric | Definition |
| --- | --- | --- |
| Discover | Qualified visit rate | Visitors who reach the product or technical details |
| Explore | Cloud Lab activation | New account saves one virtual change |
| Intent | API handoff rate | Activated accounts opening the official Krater.ai flow |
| Local activation | First-task success | Local install completes one user-defined task |
| Trust | Approval comprehension | Users can explain what an approval will do before accepting |
| Retention | Weekly active project | A returning local user opens or acts on one project |
| Advocacy | Helpful contribution | Issue, discussion, playbook PR, or reproducible benchmark report |

Never record API keys, repository content, command output, prompts, or model
answers merely to improve marketing analytics.

## Experiments

Prioritize one variable at a time:

1. Product Hunt tagline option 1 versus option 3 on owned social previews.
2. Cloud Lab CTA: “Try the virtual lab” versus “Explore before installing.”
3. First-run path: scratch task versus repository mapping.
4. Router explanation: compact rationale versus expandable decision trace.
5. README hero: CLI-first screenshot versus split CLI/IDE screenshot.

Success criteria must be defined before each experiment. Report absolute sample
size and uncertainty; do not turn a handful of clicks into a growth claim.

## Brand and claims guardrails

- Always call the product **Krater Pro**.
- Use the canonical orange crater mark without redrawing or recoloring it.
- Use: “Built by [Supratim](https://www.linkedin.com/in/supratimsircar/) with ❤️”.
- State that Krater Pro is independent and unaffiliated with Krater, Anthropic,
  Claude, or Claude Code.
- Say “designed to reduce unnecessary cost,” not “guaranteed cheapest.”
- Say “100-task catalog validated,” not “100 coding tasks passed.”
- Say “official benchmarks do not all pass,” until official evidence changes.
- Say “Cloud Lab virtual workspace,” never “cloud IDE” or “remote agent.”
- Never imply free Krater inference, issue credentials, or expose a
  maintainer-owned key.
- Never mention users, revenue, growth, market share, or valuation without
  audited evidence. A billion-dollar outcome is an ambition, not launch copy.

---

Built by [Supratim](https://www.linkedin.com/in/supratimsircar/) with ❤️
