# Connect Bridge

> **A continuity layer for multi-agent software development.**

Connect Bridge helps developers—especially solo founders using multiple AI coding agents, models, harnesses, and subscriptions—carry work from one agent or session to another **without losing the state of the work or repeatedly reconstructing context by hand**.

The name **Connect Bridge** is provisional and may change.

---

## The Problem

Modern AI-assisted development increasingly involves more than one agent.

A realistic workflow might look like:

1. One model investigates a bug.
2. Another model implements the fix.
3. A cheaper agent runs verification.
4. A stronger reasoning model performs adversarial review.
5. Another agent integrates the branch.
6. The developer returns tomorrow in an entirely new session.

The problem is that these systems usually do not share context.

Every handoff requires reconstructing things such as:

- What are we trying to accomplish?
- What repository are we working in?
- Which worktree and branch are relevant?
- What is the exact current commit?
- What changed?
- What did the previous agent discover?
- Which tests passed or failed?
- What blockers remain?
- What decisions have already been made?
- What should the next agent do?
- What should the next agent **not** redo?
- Which conclusions are facts versus assumptions?

This wastes tokens, model usage, developer attention, and time.

More importantly, reconstruction errors can cause an agent to work from stale assumptions, duplicate completed work, modify the wrong branch, undo another agent's changes, or incorrectly conclude that a task is finished.

---

# Product Thesis

**Connect Bridge makes AI development work portable between agents.**

It provides a standardized representation of the current state of a piece of work so another compatible agent can answer:

> **"Where exactly did the previous agent leave off, and what should I do next?"**

Connect Bridge should make switching between AI systems feel less like onboarding a new engineer every time and more like handing a task to another member of the same engineering team.

It is not primarily an AI memory product.

It is a:

**work handoff + state continuity layer for multi-agent development.**

---

# Why This Exists

The project comes from a practical bootstrap-founder workflow.

A solo developer may have access to several different AI systems with different:

- strengths
- context windows
- usage limits
- costs
- coding abilities
- reasoning abilities
- tools
- harnesses

The economically rational workflow is often to use each model for the work it does best.

For example:

```text
Agent A
  ↓
Investigates problem
  ↓
Connect Bridge
  ↓
Agent B
  ↓
Implements solution
  ↓
Connect Bridge
  ↓
Agent C
  ↓
Tests / reviews solution
```

Today the developer is the bridge.

**Connect Bridge should become the bridge.**

The goal is not merely convenience. Better handoffs make sophisticated multi-model workflows practical for developers who cannot afford to run the most expensive agent for every stage of a project.

---

# Target User

The first target user is:

> **A technical solo founder or small team using multiple AI coding agents to build software.**

They may use combinations of:

- Hermes
- Codex
- Claude Code
- Cline
- OpenCode
- terminal agents
- IDE agents
- local models
- hosted models
- custom agent harnesses
- agent routers such as Outsourcerer

Connect Bridge should be **vendor neutral**.

No particular model provider should own the canonical representation of the work.

---

# Core Concept: The Handoff

The fundamental Connect Bridge primitive is a **handoff**.

A handoff represents enough durable state for another agent to continue a task intelligently.

A handoff could contain:

```yaml
task:
  id: payment-hold-parity
  title: Fix payment hold parity
  objective: >
    Ensure clearing checkout intent cannot bypass the
    durable payment hold fence.

repository:
  path: /workspace/Corpus
  worktree: /workspace/Corpus-payhold-parity
  branch: session/payhold-parity
  head: 3dd391c182f32dd7c8a2331772ff991e13d74e85

status:
  state: ready_for_review
  verdict: launch_blocking_fixed

changes:
  commits:
    - 3dd391c...
  files:
    - apps/web/...

findings:
  - The unsafe sequence was reachable before the fix.
  - The new durable fence prevents the sequence.

validation:
  passed:
    - targeted unit tests
    - postgres integration tests
  failed: []

decisions:
  - Do not reset unrelated inherited work.
  - Preserve payment-hold semantics.

blockers: []

next_actions:
  - Perform adversarial review.
  - Integrate after review passes.

provenance:
  previous_agent: implementation-agent
  created_at: ...
```

The exact schema can evolve.

What matters is that the information is **structured, inspectable, portable, and grounded in the actual project state**.

---

# Handoff ≠ Giant Transcript

Connect Bridge should **not** solve continuity by blindly dumping entire chat histories into the next model.

A raw transcript contains:

- obsolete assumptions
- abandoned approaches
- duplicated information
- irrelevant discussion
- huge token costs
- ambiguous conclusions

Instead, Connect Bridge should extract and preserve the pieces of context that remain operationally relevant.

Think:

```text
conversation
     ↓
distillation
     ↓
structured project state
     ↓
next agent
```

The original source material can remain available for deeper inspection when necessary, but it should not be the default handoff mechanism.

---

# Canonical State vs Agent Commentary

Connect Bridge should distinguish **facts** from **interpretation**.

For example:

### Canonical facts

```text
Branch: session/payhold-parity
HEAD: 3dd391c...
Git status: clean
Tests: 42 passed
```

### Agent conclusions

```text
The previous agent believes the launch-blocking bug is fixed.
```

### Requested next action

```text
Perform an independent adversarial review.
```

These should not silently collapse into one another.

An agent's conclusion should never magically become canonical truth simply because it wrote it into the bridge.

---

# Core Product Principles

## 1. Local First

Repository and development context should remain local by default.

Connect Bridge should not require developers to upload their codebase or agent history to a proprietary cloud service merely to transfer context between local agents.

---

## 2. Vendor Neutral

Connect Bridge belongs **between** agents.

```text
Claude ─────┐
Codex ──────┤
Hermes ─────┤
Cline ──────┼── Connect Bridge ── Project
Local LLM ──┤
Other ──────┘
```

The architecture should avoid assumptions tied to one provider whenever practical.

---

## 3. Grounded Context Beats Generated Memory

Whenever possible, Connect Bridge should derive state from authoritative sources:

- Git
- filesystem
- test results
- structured agent artifacts
- project documentation
- explicit task state

rather than asking an LLM to remember what happened.

---

## 4. Cheap to Read

A handoff should save tokens, not consume more of them.

Agents should be able to request progressively deeper context.

For example:

```text
project summary
      ↓
active task
      ↓
task handoff
      ↓
specific findings
      ↓
source artifact / transcript
```

Do not automatically inject the entire project history into every session.

---

## 5. Humans Remain in Control

Connect Bridge should make agent state visible and inspectable.

Developers should be able to understand:

- where information came from
- which agent produced it
- what changed
- what is verified
- what remains uncertain

---

## 6. Do Not Become Another Coding Agent

Connect Bridge should resist product creep.

Its initial job is not to:

- write the application
- replace Hermes
- replace Claude Code
- replace Codex
- choose models
- become another autonomous coding harness

Its job is to make those systems work together better.

---

# Hermes Integration

Hermes is an excellent first-class integration because it can operate as an orchestration environment while Connect Bridge supplies continuity.

Conceptually:

```text
                    ┌───────────────┐
                    │    Hermes     │
                    │ Orchestration │
                    └───────┬───────┘
                            │
                     Connect Bridge
                            │
             ┌──────────────┼──────────────┐
             │              │              │
          Codex          Claude        Other Agent
             │              │              │
             └──────────────┼──────────────┘
                            │
                        Repository
```

Hermes should be able to ask questions such as:

- What project am I in?
- What work is currently active?
- What happened on this task?
- Which agent worked on it last?
- What branch contains the work?
- What is its HEAD?
- What changed?
- What tests have already been run?
- What remains unresolved?
- What should happen next?
- Show me the artifact produced by the previous agent.

---

# Outsourcerer Integration

Connect Bridge can complement Outsourcerer without duplicating it.

A clean separation is:

```text
Hermes
   │
   │ decides what work should happen
   ▼
Outsourcerer
   │
   │ decides where/how execution occurs
   ▼
External Agent
   │
   │ performs work
   ▼
Connect Bridge
   │
   │ preserves result + state
   ▼
Hermes / Next Agent
```

In this model:

- **Hermes = orchestrator**
- **Outsourcerer = execution/model router**
- **Connect Bridge = continuity/state layer**

These responsibilities should remain distinct.

---

# Agent Observability

Connect Bridge can eventually provide a common event model for work performed by external agents.

Examples:

```text
job.started
job.progress
job.completed
job.failed
job.cancelled
```

These could map into richer host-specific events.

For a Hermes integration, for example:

```text
job.started
      ↓
subagent.started
```

A job may expose:

- stable job ID
- parent task ID
- agent
- model
- harness/provider
- status
- start/end time
- progress
- files modified
- commits created
- summary
- token usage when available
- estimated or actual cost when available
- result artifacts

This would allow work happening outside Hermes to appear coherently inside a Hermes-oriented workflow.

---

# Control Plane

Longer term, Connect Bridge should support **controlled steering**, not merely passive observation.

For example:

```text
inspect job
pause job
cancel job
send clarification
change task instruction
request status
```

Where supported, a Hermes action could map through Connect Bridge to the underlying execution system.

This should use explicit, narrowly scoped control operations rather than arbitrary shell execution.

---

# Project Context

Task handoffs are only one layer.

An agent also needs lightweight awareness of the broader project.

Connect Bridge should eventually expose things such as:

```text
project
├── repository state
├── worktrees
├── active tasks
├── recent handoffs
├── project documents
├── decisions
├── current blockers
└── relevant agent artifacts
```

An agent joining the project should be able to cheaply establish orientation without scanning the entire repository.

---

# MCP

MCP is a strong initial interoperability layer.

A possible Connect Bridge MCP surface could eventually look like:

```text
connect.project_snapshot
connect.active_tasks
connect.task
connect.handoff
connect.recent_handoffs

connect.git_state
connect.worktrees
connect.changes

connect.agent_jobs
connect.agent_job
connect.agent_artifact

connect.search_context
connect.read_context
```

Exact names are not important yet.

The important design property is **progressive context retrieval**.

The agent asks for what it needs instead of receiving a massive mandatory context payload.

---

# Agent Skills / Plugin Packaging

Connect Bridge should be designed so that an agent can learn **how to use the bridge**, not merely receive MCP tools.

A portable agent plugin could contain:

```text
connect-bridge/
├── plugin.json
├── mcp.json
└── skills/
    ├── project-state/
    ├── task-handoff/
    └── continue-work/
```

MCP provides the **facts and operations**.

Skills teach the agent **when and how to use them**.

For example, a `continue-work` skill might teach an agent:

1. Read the current project snapshot.
2. Identify the active task.
3. Read the latest handoff.
4. Verify critical repository state directly.
5. Avoid repeating completed investigation.
6. Continue from `next_actions`.
7. Produce a new handoff before ending the session.

That pattern creates continuity across otherwise unrelated harnesses.

---

# The Ideal Experience

Eventually the workflow should feel like this.

A developer tells Hermes:

> Continue the USDC launch work.

Hermes queries Connect Bridge and discovers:

```text
Active task:
USDC funds-disposition validation

Previous agent:
Muse Spark

State:
READY FOR INTEGRATION

Branch:
session/usdc-funds-disposition

HEAD:
ffe547c...

Previous findings:
Harness gap already fixed.
Validation clean.

Next action:
Independent adversarial review before integration.
```

Hermes can immediately choose the appropriate agent and continue.

No 4,000-word copy/paste prompt.

No developer reconstructing yesterday's session.

No expensive model spending its first several thousand tokens rediscovering information another model already established.

That is the product.

---

# MVP

The MVP should remain deliberately small.

## MVP Goal

Demonstrate that one AI coding agent can perform work and another agent can reliably resume it using Connect Bridge with substantially less manual reconstruction.

### MVP should support:

- identifying a project/repository
- Git branch + HEAD detection
- worktree awareness
- current working-tree state
- a structured task
- structured handoff creation
- previous-agent metadata
- summaries/findings
- validation/test results
- blockers
- decisions
- next actions
- files/commits touched
- timestamp/provenance
- retrieval of recent handoffs
- retrieval of current task state
- MCP access
- a basic Hermes-oriented skill demonstrating the workflow

### Prefer automatic facts where possible.

For example, Connect Bridge should determine:

```text
HEAD
branch
git status
worktree
```

itself rather than trusting an agent to type them correctly.

---

# Initial Safety Model

The first version should prefer **read-only inspection** wherever possible.

Do not create an unrestricted bridge that gives every connected model arbitrary filesystem or shell access.

Important protections include:

- workspace allowlisting
- path traversal protection
- symlink escape protection
- secret-file exclusion
- bounded filesystem reads
- bounded search
- explicit project roots
- no arbitrary command execution through generic MCP tools
- provenance on agent-produced state

Any future write capability should be narrow and explicit.

For example, a future planning capability could permit an agent to update a designated canonical TODO through a controlled tool rather than exposing unrestricted file writes.

---

# Non-Goals for MVP

Connect Bridge does **not** initially need:

- a cloud platform
- user accounts
- billing
- a large web dashboard
- its own coding agent
- its own LLM
- vector databases
- long-term semantic memory
- autonomous model selection
- arbitrary remote execution
- enterprise collaboration
- perfect support for every harness
- a universal agent protocol

The MVP needs to prove one thing exceptionally well:

> **Agent B can continue Agent A's real software-development work without the human having to reconstruct the context.**

---

# Success Criteria

A successful early demo should be able to show:

### Without Connect Bridge

```text
Agent A finishes
      ↓
Founder reads output
      ↓
Founder reconstructs history
      ↓
Founder writes giant prompt
      ↓
Agent B re-investigates repository
      ↓
Agent B eventually continues
```

### With Connect Bridge

```text
Agent A finishes
      ↓
Connect Bridge records handoff
      ↓
Agent B reads handoff + verifies state
      ↓
Agent B continues
```

Metrics worth eventually measuring:

- tokens required to onboard the next agent
- time before the next agent performs useful work
- duplicated investigation
- incorrect assumptions during handoff
- manual text copied by developer
- cost of switching between agents

---

# Longer-Term Vision

If the core primitive works, Connect Bridge can evolve into the missing connective tissue between increasingly heterogeneous AI development environments.

Possible future capabilities include:

- cross-harness agent job observation
- bidirectional steering
- task trees
- structured decision history
- automated session closeout
- automated handoff generation
- stale-state detection
- handoff verification
- conflict detection
- canonical project TODO integration
- reusable project context
- cost/token tracking
- agent performance comparisons
- task provenance
- distributed/remote agents
- richer Agent Plugin support
- integrations for additional coding harnesses

Eventually a developer should be able to fluidly move work between models and harnesses without thinking about the boundaries between them.

---

# Open Source Philosophy

Connect Bridge should be useful as an open interoperability layer rather than a mechanism for locking developers into another platform.

The core protocol, schemas, and local tooling should be suitable for open source.

A healthy ecosystem could allow third parties to build adapters for:

```text
Hermes
Claude Code
Codex
Cline
OpenCode
Cursor
local agents
agent routers
future harnesses
```

The more fragmented the agent ecosystem becomes, the more valuable a neutral continuity layer becomes.

---

# Design Test

When considering a feature, ask:

> **Does this make it easier for one agent to understand and safely continue work performed by another agent?**

If yes, it may belong in Connect Bridge.

If it primarily makes Connect Bridge itself into an orchestrator, coding agent, IDE, or project-management suite, it probably does not.

---

# North Star

**Developers should be able to change models, agents, harnesses, and sessions without losing the thread of their work.**

The developer should choose an AI system because it is the best system for the next task—not because all of the project's context is trapped inside the previous one.

Connect Bridge makes the work portable.
