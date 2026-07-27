# Krater Pro — Product Hunt launch listing

> **Publication control:** This is launch-ready copy, not permission to publish.
> The production Cloud Lab has completed release validation. Replace the
> Product Hunt URL placeholders and review the final submission preview before
> publishing. The Cloud Lab is a bounded virtual workspace—not a remote shell
> or hosted repository runner.

## Submission fields

**Name**

Krater Pro

**Tagline options**

1. A local coding agent for your terminal and browser IDE _(54 characters)_
2. One coding agent. Local CLI, full IDE, smarter routing. _(55 characters)_
3. Agentic coding with smart model routing and local control _(57 characters)_
4. Route every coding task to the right Krater AI model _(52 characters)_

Recommended: **A local coding agent for your terminal and browser IDE**

**Short description — 177 characters**

Krater Pro pairs a local coding CLI and agentic browser IDE with smart model
routing, project switching, approvals, 40+ language playbooks, and
bring-your-own Krater API access.

**Extended description — 423 characters**

Krater Pro brings one tool-using coding agent to a local CLI and a browser IDE.
Switch between local folders, public GitHub clones, or scratch workspaces; let
the Smart Coding Router balance capability and cost; or pin
moonshotai/kimi-k3. Bring your own Krater API key. A companion Cloud Lab lets
people create accounts and save a bounded virtual workspace before installing
locally—no remote shell or repository execution.

**Topics — choose no more than three**

- Developer Tools
- Artificial Intelligence
- Productivity

**Pricing**

Free and open source. Live model usage requires the user's own Krater API
access and may be billed by Krater.ai.

**Primary URL**

https://krater-pro.pages.dev/

**Additional links**

- GitHub: https://github.com/SupratimSircar05/krater-pro
- API access: https://krater.ai/
- Maker: https://www.linkedin.com/in/supratimsircar/

**Suggested asset order**

1. `gallery-01-one-agent.png` — the CLI + IDE promise
2. `gallery-02-smart-router.png` — routing, exact override, and efficiency
3. `gallery-03-workspaces-cloud.png` — projects, Cloud Lab, and trust boundary

The matching SVG files are the editable sources.

**Thumbnail**

Upload `thumbnail.png` at 240×240. `thumbnail.svg` is the editable source.

## Maker's first comment

Hey Product Hunt — I’m Supratim, the maker of Krater Pro.

I built it because coding agents often make you choose between a terminal-first
workflow, a visual IDE, model flexibility, and cost control. Krater Pro puts the
same tool-using agent in a local CLI and browser IDE, so the conversation,
selected project, approvals, and model decision stay coherent.

You can switch among a local folder, an isolated clone of a public GitHub repo,
or a scratch workspace. The Smart Coding Router compares the available Krater
model catalog and chooses a cost-conscious qualified model; if predictability
matters more, you can pin an exact model such as `moonshotai/kimi-k3`. The
product also includes 40+ language and ecosystem playbooks, cache-friendly
context handling, explicit token telemetry, protected-path rules, and approval
gates for agent-proposed changes.

For people who want to explore before installing, the companion Cloud Lab has
accounts and saved progress in a bounded virtual workspace. It intentionally
does **not** expose a shell, clone repositories, or touch your computer. Live
inference uses your own Krater API key transiently; the project never ships or
shares my personal key.

I also want to be transparent about evaluation. Krater Pro includes a validated
100-task expert benchmark catalog and adapters for three public SWE suites, but
the official benchmark suites do not all pass today. The repository publishes
the limits and observed failures instead of turning adapter checks into
performance claims.

I’d especially value feedback on three things: where model routing should be
more explainable, which approval boundaries feel too strict or too loose, and
what would make the first local coding task easier. I’ll be here to answer
questions and learn from what you try.

Built by [Supratim](https://www.linkedin.com/in/supratimsircar/) with ❤️

## Frequently asked questions

### Is Krater Pro affiliated with Krater, Anthropic, Claude, or Claude Code?

No. Krater Pro is an independent, clean-room implementation. It uses Krater's
OpenAI-compatible API when a user supplies their own credential.

### Does the hosted Cloud Lab run commands or edit my real repository?

No. Cloud Lab is a constrained virtual-workspace demo. It can save bounded
virtual files, chat messages, and an active path to the signed-in account. It
does not provide an arbitrary shell, clone a repository, mount a local folder,
or claim to have modified real code.

### Where does real agentic coding happen?

In the local Krater Pro CLI or local browser IDE, against the project you
select. The same agent session can inspect files, propose edits, run bounded
commands, inspect Git state, and request approval for protected actions.

### How are API keys handled?

Local users can configure `KRATER_API_KEY` in an ignored `.env`, the process
environment, or a single CLI invocation. The GUI can hold a pasted override
only in tab memory. Cloud Lab accepts only the visitor's own key for a live
request and must never persist it to D1, cookies, logs, assets, or server
configuration.

### Can Krater Pro reuse a logged-in Krater browser session?

No. Krater Pro does not scrape cookies or private browser session tokens.
Krater.ai remains the first-party place to create an account, confirm plan
eligibility, and obtain an API key.

### Which models can I use?

You can hard-select an exact model exposed to your Krater account, including
`moonshotai/kimi-k3`, or leave the model on Auto so the Smart Coding Router can
choose from the live catalog using task requirements, model capability
metadata, and provider-reported pricing.

### What does the Smart Coding Router optimize?

It filters for requirements such as tool calling and context size, estimates a
task quality target, calculates an accuracy/cost frontier, and selects the
least-expensive candidate that clears that target. The UI reports the model,
tier, confidence, source, and rationale. It is a heuristic router, not a
guarantee of lowest final cost or task success.

### What are the token and cost controls?

Krater Pro uses progressive skill loading, repository maps, cache-friendly
prompt structure, bounded tool output, read-only result reuse, conversation
compaction, response-style controls, and per-session token budgets. It surfaces
reported input, output, cached, and session totals where the provider supplies
them.

### Does it support my programming language?

The built-in skill routes to more than 40 language and ecosystem playbooks,
including JavaScript/TypeScript, Python, Rust, Go, Java, C/C++, C#, Swift,
Kotlin, SQL, shell, Solidity, functional languages, infrastructure formats,
hardware description languages, and more. These playbooks guide the agent;
they are not language-server or compiler implementations.

### Are the benchmark tasks solved?

The 100-task catalog passes offline harness validation, which validates the
catalog and runner—not model correctness. The official DeepSWE, SWE-Atlas, and
SWE-bench Pro-os suites do not all pass. Current evidence and resource limits
are documented in the repository.

### Is command execution fully sandboxed?

Every command is workspace-scoped, bounded, filtered, and stripped of
unrelated credentials. On supported macOS systems, Krater Pro adds OS-level
confinement. On platforms without that facility, project code still executes
with the Krater Pro process user's permissions; users should review commands
and keep projects under version control.

### What does it cost?

The Krater Pro source and Cloud Lab account are free. Live inference uses the
user's own Krater API access, with eligibility and usage charges controlled by
Krater.ai.

## Launch-day posts

Replace `[PRODUCT_HUNT_URL]` only after the Product Hunt post is live. The
production Cloud Lab URL is https://krater-pro.pages.dev/. Share organically;
do not ask for or incentivize upvotes.

### X / Twitter

I built Krater Pro: one local coding agent for your terminal + browser IDE.

Switch local/GitHub/scratch projects, use a cost-aware Smart Router or pin Kimi
K3, and bring your own Krater API key.

Try it and tell me what to improve: [PRODUCT_HUNT_URL]

### LinkedIn

Today I’m launching **Krater Pro** — an open-source coding agent that works in
both your terminal and a full local browser IDE.

The idea is simple: keep the agent, project context, approvals, and model choice
coherent wherever you prefer to work.

Krater Pro includes:

- local, public GitHub, and scratch project switching;
- a Smart Coding Router that balances task requirements with
  provider-reported cost;
- exact model overrides, including `moonshotai/kimi-k3`;
- 40+ language and ecosystem playbooks;
- token, cache, compaction, and session-budget controls;
- workspace confinement and explicit approvals; and
- a 100-task expert benchmark catalog with honest public evaluation notes.

There is also a companion Cloud Lab where people can create an account and save
progress in a safe virtual workspace before installing locally. It is
deliberately not a remote shell, and every live model request uses the visitor's
own Krater API key.

I’m not claiming every official coding benchmark passes. I’m publishing the
evidence, including the limits and failures, because trust matters in developer
tools.

If you try it, I’d love candid feedback on the routing explanations, approval
flow, and first-run experience: [PRODUCT_HUNT_URL]

Built by [Supratim](https://www.linkedin.com/in/supratimsircar/) with ❤️

### Show HN

**Title:** Show HN: Krater Pro – a local coding agent for the terminal and a
browser IDE

**Post:**

I built Krater Pro, an open-source TypeScript coding agent powered by a
user-supplied Krater API key.

The same agent/session runs in a CLI and a local React IDE with project
switching, file exploration and conflict-safe edits, bounded commands, Git
inspection, streaming tool activity, and approval cards. Auto mode uses an
auditable cost/capability router; exact model selection, including
`moonshotai/kimi-k3`, is also supported.

The repository includes 40+ progressively loaded language playbooks and a
100-task benchmark catalog. Important caveat: catalog validation is not a model
score, and the official benchmark suites do not all pass. The current evidence
is documented rather than hidden.

The public Cloud Lab is a separate, constrained virtual demo with accounts and
saved progress. It has no arbitrary shell or repository execution, and it
never receives a maintainer-owned API key.

Code: https://github.com/SupratimSircar05/krater-pro

Demo: https://krater-pro.pages.dev/

I’d appreciate technical feedback, especially on the trust boundaries, router
heuristics, and what you would need before using it on a real project.

### GitHub release

**Title:** Krater Pro — local CLI, agentic IDE, and Smart Coding Router

Krater Pro brings one tool-using coding agent to a terminal workflow and a
polished local browser IDE. This release adds project switching across local,
public GitHub, and scratch workspaces; cost-aware automatic model routing; exact
Kimi K3 selection; progressive language playbooks; token and cache controls;
workspace protections; a validated 100-task catalog; and public-suite adapters
with transparent status reporting.

Start here: [README](https://github.com/SupratimSircar05/krater-pro#readme)

### Community post

I’ve released Krater Pro, a local-first coding agent with both a CLI and browser
IDE. I’m looking for practitioner feedback—not votes—on its Smart Coding
Router, project-switching flow, and approval/security boundaries.

The source, threat model, and benchmark limitations are public:
https://github.com/SupratimSircar05/krater-pro

Product Hunt discussion: [PRODUCT_HUNT_URL]

## Comment-response starters

Use these as starting points, then answer the actual person rather than pasting
a script.

**“Why another coding agent?”**

The main bet is that terminal and visual IDE workflows should share one agent
and one trust model, while model routing and exact overrides stay visible. I’d
be interested in which part feels genuinely useful—or redundant—to you.

**“Why bring your own key?”**

BYOK keeps provider access and billing between the user and Krater.ai and
prevents the hosted companion from becoming a shared-key proxy. It adds setup,
though, so feedback on the handoff is especially useful.

**“Can I run my repository in the cloud?”**

Not in Cloud Lab. That boundary is intentional: the hosted demo is virtual and
has no shell. Real repository access belongs in the local CLI/IDE, where users
can see the selected workspace and approve protected actions.

**“What is the benchmark score?”**

There is no aggregate score I can honestly claim. The custom 100-task catalog
passes harness validation, not solution evaluation, and the official suites do
not all pass. The repository documents the exact observed status.

## Final pre-publish checklist

- [ ] Cloud Lab production URL resolves on desktop and mobile.
- [ ] Account creation, sign-in, sign-out, and seven-day session behavior pass.
- [ ] Saved virtual progress survives refresh and remains isolated by account.
- [ ] BYOK request succeeds with a test user's key and no key appears in D1,
      logs, cookies, analytics, static assets, or error responses.
- [ ] “Get a Krater API key” opens the official Krater.ai destination.
- [ ] Cloud Lab clearly says “virtual workspace” and “no shell.”
- [ ] GitHub release commit/tag and installation steps are public.
- [ ] Product Hunt URLs replace every bracketed placeholder.
- [ ] Thumbnail is 240×240 and gallery images are 1270×760.
- [ ] Maker profile is complete and eligible to post.
- [ ] Pricing disclosure says Krater API usage is separate.
- [ ] The first comment includes the benchmark and Cloud Lab limitations.
- [ ] No post asks for upvotes, coordinates voting, or offers an incentive.
