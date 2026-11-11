# The software factory

Status: design (D36 in `decisions.md`). Nothing is built yet. This document says what the
factory is, what each agent produces, where the operator decides, what the engine must gain,
and the order to build it in. It builds on the development flock (`flock.md`) and the engine
work recorded in D25 to D35. Code references are at commit `5d667bb`.

## Goal

Turn an idea typed into Magpipe into merged code with two human decisions on the way: approving
the spec, and answering the question to merge. Everything between those runs unattended, in
parallel where the work allows, with Linear as the record of what was asked, what state it is
in, and what each agent found.

## Not in scope

- Merging without a person. The factory starts with pull requests and a question to merge.
  Earning unattended merges for low-risk work is the last phase, and its own decision.
- Deploying. No agent gets a deploy tool.
- Replacing Linear's own views. Magpipe shows the pipeline; Linear stays the place issues live.
- Other trackers and other git hosts. The seams are named below, but only Linear and GitHub
  are designed here.

## The pipeline

One idea becomes one Linear issue (the spec) and one or more sub-issues (the goals). Each goal
is built on its own branch in its own git worktree and lands through its own pull request.

| #   | Stage            | Agent        | Produces                                          | Passes when                                              |
| --- | ---------------- | ------------ | ------------------------------------------------- | -------------------------------------------------------- |
| 1   | Write the spec   | Spec Builder | A spec with fixed headings                        | It is written                                            |
| 2   | Review the spec  | Spec Review  | A checklist verdict; the Linear issue             | Every checklist item holds                               |
| G1  | **Approve**      | Operator     | The issue moved to the approved status            | The operator says so, in Linear or in Magpipe            |
| 3   | Split into goals | Goal Builder | One sub-issue per goal                            | It is written                                            |
| 4   | Review the goals | Goal Review  | A checklist verdict                               | Every checklist item holds                               |
| 5   | Write the tests  | Test Agent   | Failing tests for the goal, committed             | The tests exist and fail for the right reason            |
| 6   | Build            | Code Agent   | Commits on the goal's branch                      | It finishes                                              |
| 7   | Run the tests    | Test Agent   | Script results; proof the tests were not weakened | Every script exits 0 and the test files are unchanged    |
| 8   | Review the code  | Code Review  | Tiered findings against the goal                  | No blocking finding                                      |
| 9   | Try to break it  | Code Skeptic | A failing test, or nothing                        | It could not write a test that fails                     |
| 10  | Open the PR      | Merge Agent  | A pushed branch and a pull request                | CI is green                                              |
| G2  | **Merge?**       | Operator     | An answer to the question                         | The operator says so, in Linear, in Magpipe or on GitHub |
| 11  | Merge            | Merge Agent  | The merged pull request; the issue closed         | The merge lands                                          |

Stages 5 to 11 run once per goal. Goals with no dependency on each other run at the same time.

## The agents

Nine agents, each defined by what it writes and the evidence it must give. Reviewers that only
hold opinions agree with each other and with the author, so every judge here either checks a
fixed list or produces something that runs.

| Agent        | Reads                                | May write                                   | Evidence it owes                                                      | Model             |
| ------------ | ------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------- | ----------------- |
| Spec Builder | The idea, the repository, its docs   | The spec text                               | Assumptions listed, not hidden                                        | claude-opus-5-5   |
| Spec Review  | The spec, the repository             | The Linear issue, once the spec passes      | The checklist, item by item                                           | claude-opus-5-5   |
| Goal Builder | The issue, the repository            | Sub-issues                                  | Files each goal touches; which goals depend on which                  | claude-opus-5-5   |
| Goal Review  | The issue, the sub-issues            | Comments on them                            | The checklist, item by item                                           | claude-sonnet-5-5 |
| Test Agent   | The goal, the repository             | Test files on the goal's branch; runs tests | Tests that fail before the build; script exits after it               | claude-sonnet-5-5 |
| Code Agent   | The goal, the tests, the repository  | Code on the goal's branch                   | Commits; the scripts it ran                                           | claude-sonnet-5-5 |
| Code Review  | The goal, the diff, the test results | Comments on the sub-issue                   | Each finding with path:line and a fix; blocking ones tied to the goal | claude-opus-5-5   |
| Code Skeptic | The goal, the diff, the repository   | One test file on the goal's branch          | A test that fails on the branch, or no objection                      | claude-opus-5-5   |
| Merge Agent  | The branch, CI, the sub-issue        | Push, pull request, merge, issue status     | CI status; the merge commit                                           | claude-sonnet-5-5 |

**The spec's fixed headings:** Problem, Outcome, Acceptance criteria (each one testable), Not in
scope, Constraints, Assumptions and open questions. A run takes no input once it starts, so the
Spec Builder lists what it assumed instead of asking, and the operator answers in a follow-up
before the review, or edits the issue in Linear after it.

**The Spec Review checklist:** every acceptance criterion can be checked by a test or a command;
the non-goals are stated; nothing contradicts the repository's `CLAUDE.md`; the size is one
issue's worth, or it says where it would split. A spec that fails goes back to the Spec Builder
(a bounded send-back, D31). Only a spec that passes becomes a Linear issue.

**The Goal Review checklist:** every acceptance criterion of the spec belongs to exactly one
goal; each goal names the files it expects to touch; two goals that touch the same file are
ordered, not parallel; each goal can be tested on its own.

**Three judges, three kinds of evidence.** The Test Agent writes the tests from the goal before
any code exists, so the Code Agent builds against tests it did not write. After the build, the
Test Agent runs the scripts and checks, with a diff against its own commit, that the test files
are unchanged. Code Review reads the diff against the goal and the test results, and skips
style. The Code Skeptic gets one job: write a test that fails. If it cannot, it has no
objection; if it can, the test is the finding and goes back to the Code Agent. An objection
without a failing test does not block.

The Researcher from the flock stays available as a reader the builders can be given help from;
the Planner, Coder, Reviewer and Verifier are superseded by the agents above and their prompts
are the starting point for them.

## The two gates

**G1, approve the spec.** The spec lands in Linear in a "spec ready" status. The operator
approves by moving it to the approved status in Linear, or by pressing Approve on the factory
screen in Magpipe. The button sets the status in Linear, so Linear holds the one answer and
both doors lead to it. Editing the issue before approving is how the operator changes the spec.

**G2, the question to merge.** When a goal's pull request is open and CI is green, the Merge
Agent posts the question on the sub-issue, with the review verdict, the skeptic's result and
the test results beside it, and the goal waits (the run status from D30). The operator answers
in Magpipe, by moving the sub-issue to the merge status in Linear, or by merging the pull
request on GitHub, which the factory notices and closes out. A no sends the goal back to the
Code Agent with the operator's note.

## Linear as the record

- **One issue per spec, one sub-issue per goal.** The spec is the issue's description; each
  goal's description holds its acceptance criteria, files and dependencies.
- **A label marks what the factory owns.** Magpipe acts only on issues that carry it, so the
  rest of the workspace is never touched.
- **Statuses are mapped, not assumed.** Teams name their statuses differently, so Settings
  maps six pipeline states (spec ready, approved, building, merge question, done, needs you)
  to the team's own.
- **Findings are comments.** Each verdict is a comment on the issue it concerns, written by the
  agent that owns it. The pull request links the sub-issue.
- **Text from Linear is data.** A spec the operator approved is an instruction; a comment from
  anyone else is not. Agents are told so, and only the two builders read comments at all.

## When something goes wrong

Every loop has a bound and every bound has an exit.

- **Send-backs are counted** (D31): the spec once, a goal's code up to twice across review,
  skeptic and tests. When the rounds are spent the issue moves to "needs you" with the last
  findings as a comment, and the goal's run ends there. The other goals carry on.
- **The spend cap still stops everything** (D32). A stopped goal says so on its sub-issue.
- **A goal that conflicts on merge** is rebased in its worktree and its tests run again. If
  the rebase does not apply cleanly, it goes to "needs you".
- **Linear or GitHub out of reach:** the run waits and retries; nothing is recorded only in
  Magpipe that Linear should hold.

## What the engine has, and what it needs

Already there: the approval wait and note (D30), bounded send-backs (D31), the spend cap (D32),
resuming a step from its record (D33), repository conventions in every prompt (D34), a loader
for a roster (D35), typed repository operations with a script runner (D27), one writer per work
tree (D28), and each step's recorded branches, commits and script results handed to the next
step (D29).

Needed, smallest first:

| Need                       | Why                                                                                    | Shape                                                                                                                                                                             |
| -------------------------- | -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runs from a template       | A factory runs the same stages every time; the orchestrator improvises a plan per task | `createRun` takes a preset plan. The engine already skips planning when a plan exists, so a template is a fixed list of steps with the stage's instructions.                      |
| The roster and templates   | Nine agents and three templates must match this document                               | `lib/factory.ts`, loaded like the flock and pinned to this document by a drift test.                                                                                              |
| A tracker seam             | Stages read and write Linear; tests must not need it                                   | A small interface (create issue, sub-issue, comment, set status, list by label and status) with a Linear implementation over its MCP server and a scripted one for tests.         |
| A watcher                  | Nothing in Magpipe starts a run on its own                                             | A poll of Linear on a timer, in the app, that starts the next template when an issue's status says so. A desktop app cannot receive webhooks. Each transition is acted on once.   |
| A worktree per goal        | One checkout allows one writer, and goals should build in parallel                     | `git worktree add` per goal under the data folder; repository operations resolve against the run's worktree. The write lock is keyed by work tree, so parallel goals already fit. |
| Push, as a typed operation | No agent can push today                                                                | `git_push`: only the run's own `magpipe/…` branch, to `origin`, never forced, never the default branch. Granted to the Merge Agent alone.                                         |
| Pull requests and merging  | The Merge Agent must open, watch and merge                                             | GitHub's MCP server with a token that can write pull requests, and only the pull request tools ticked for the Merge Agent.                                                        |
| A protected-paths check    | The Code Agent must not weaken the tests                                               | First as evidence (the diff check in stage 7); later as a guard on `write` for a step.                                                                                            |
| The factory screen         | The operator needs the pipeline at a glance and both gates in reach                    | A board of issues by stage, each goal with its branch, results and verdicts from the recorded work, and the two buttons. Home's prompt gains "Send to the factory" beside Run.    |
| More than two runs at once | Parallel goals are parallel runs                                                       | The engine's run limit becomes a setting, with the spend cap as the governor.                                                                                                     |

## Build order

Each phase is one pull request, useful on its own, and testable with the scripted model.

1. **Templates and the roster.** Runs from a preset plan; `lib/factory.ts` with the nine agents
   and the spec template; "Send to the factory" produces a reviewed spec in Magpipe. No Linear
   yet.
2. **Linear.** The tracker seam, the status mapping in Settings, and the spec landing as a
   labelled issue. The watcher, and gate G1 from both doors.
3. **Goals.** The goal template: sub-issues, their checklist review, dependencies between them.
4. **Building one goal.** The build template on the bound repository as it is today: tests
   first, build, run, review, skeptic, with send-backs and "needs you". One goal at a time.
5. **Worktrees and parallel goals.** A worktree per goal, the run limit as a setting, goals in
   dependency order.
6. **Pull requests and the merge question.** `git_push`, the Merge Agent, gate G2 from all
   three doors, rebase and re-test before each merge.
7. **The factory screen.** The board, replacing the lists phases 1 to 6 get by with.
8. **Earning unattended merges.** A rule the operator sets (for example: a label, every script
   green, no finding, the skeptic silent) under which G2 answers itself. Its own decision.

## To confirm before building

1. **Linear's MCP server with an API key.** Magpipe stores pasted tokens, not OAuth sessions
   (D13). If Linear's server needs OAuth, the tracker seam talks to Linear's API directly
   instead.
2. **Polling limits.** How often the watcher may ask Linear without hitting its rate limits;
   one query per minute by label and status should be far inside them.
3. **Unattended use of a Claude subscription.** D22 left the terms question open, and a factory
   that runs without a person watching makes it sharper. The API backend is the safe default
   for the factory.
4. **The app must be open.** The watcher lives in the desktop app. A factory that should run
   while the laptop sleeps needs the hosted mode, which is not built.
