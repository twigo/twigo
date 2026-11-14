# Twigo: strategic and architectural review, November 2026

Reviewed by Claude Fable 5.2 on 2026-11-14, at commit `52d2c28f` (`main`, "feat: metrics", #45).
Scope: the documents, the rules, the CI, every crate and package, and the public web as it stood that day.

## How to read this

- Every finding is marked **Fact (verified)**, **Judgement** (an opinion, with its confidence) or **Bet** (a prediction, with its confidence).
- A claim about the code cites `file:line` at `52d2c28f`; I read each cited line myself, also where a research agent found it first.
- A claim about the outside world cites a URL and its date; "accessed 2026-11-14" stands where a page shows no date.
- "Not verified" is said in place.

## Method and assumptions

- I read `docs/ARCHITECTURE.md` whole, every file in `docs/decisions`, `docs/spikes` and `docs/bench.md`, `TODO.md`, `.claude/rules`, `CONTRIBUTING.md`, the workflows, and most of `docs/research`.
- I traced the policy path through the code myself: the gate, the classifier, the client factory, the command bus, the proxy, the terminal, the Tauri commands.
- Seven research agents on the same model worked from separate briefs: the category, upstream Kubernetes and scale, the AI landscape, the platform bets, distribution and growth, and two code audits (Rust; TypeScript and the boundary).
  They gathered evidence and proposed; the judgements here are mine, and I re-read every line of code I cite from them.
- External facts were first read by those agents on 2026-11-14, many through a fetch tool that summarises pages.
  Two further agents then checked the finished text: one read the 115 URLs it cited again as raw text, and one checked each of its 306 `file:line` citations and every count against the repository.
  They reported 21 and 36 problems; I checked each against the page or the code before correcting it, and the text carries those corrections.
  The ten URLs that the corrections added I read as raw text myself.
  Where a claim still rests on a search summary or a secondary report, the text says so.
- Nothing was built or run: no build, no test, no bench, no cluster.
  Every number is the repository's own, or a count I made with `find`, `wc`, `grep` or `git`, or arithmetic that is labelled as such.
- Reddit could not be read by any tool, so no finding rests on it.
- Assumptions: the beta is one to three months away; one person maintains Twigo beside two other products; the documents state intent, not truth.
- I know of the earlier NATS IDE only what the brief says.

## 1. Executive summary

Twigo's engineering is ahead of its category where a reviewer can read it: one gate below every client, lists sorted and windowed in Rust, a credential runner of its own, a command bus that checks friction in Rust, no silenced lint anywhere.
Its plan is behind where a user will meet it first.
Five things matter most.

1. **The safety promise is half built, and M3 would ship the other half broken.**
   Every request passes the gate (2.1.1).
   But a context nobody marked is `read-write`, one unconfirmed call or a line in a kubeconfig can lower a lock, a damaged state file resets the person's locks, the gate's audit records only writes, and every actor, the coming agents included, writes unasked in a `read-write` context, Secrets being the one exception for agents and extensions (2.1.2 to 2.1.5, 2.1.19, 2.3.3).
   Fix the lock's setter, the default and the audit before the beta, and give agents no write path: they read and propose, the person applies (2.3.4).
2. **"Performance is the product" is proven at one point: 5,000 small pods, on loopback, on macOS, on an M4 Max.**
   No list asks for compression, so by arithmetic a remote cluster at 20 Mbit/s misses the first-paint budget four times over.
   A person with namespace-scoped access and about 22 namespaces sees no rows, and three paused `kubectl logs -f` can freeze a cluster's one connection (2.4.10, 2.4.11).
   Nothing was measured on Linux, past 5,000 pods or from launch, and the app holds about 650 MB, so "lightweight" is not a claim to make (2.1.15, 2.4.2, 2.4.3).
   Compress, remove the two cliffs, measure, and publish the comparison.
3. **M3 as written is the wrong beta.**
   Everything in it is at zero lines, and its largest part, a WASM extension runtime, serves one first-party provider that needs no local code (2.4.7 to 2.4.9, 2.5.1).
   Cut it with the settings and keybindings editors, the MCP gateway and the agent panel.
   Spend the time on what cannot be hurried: signing and release, diagnostics, an alpha with outsiders on their own clusters, documentation (2.5.1 to 2.5.3).
   The order of work, not the code, is what the previous product got wrong.
4. **The position has to change, because the gap Twigo was designed for has closed.**
   Free and open clients are widely installed, some forty lookalikes exist, and the incumbents shipped an MCP server in March and HTTP/2 and protected contexts within three weeks of this review (2.2.1).
   What stays durable is the keyboard workbench, the credential runner, the depth of the gate and, once they are measured at scale, Rust-side tables, and all four pay off most for the operator of many clusters.
   The wedge is triage: what is wrong, why, and what changed, first in one cluster and then across the fleet (2.2.2 to 2.2.4).
5. **The cost of the next year sits in three things the maintainer controls.**
   An architecture document of 48,900 words that no person or agent can read before a change (2.1.7, 2.1.8).
   A mock backend that is a second implementation of the core and already disagrees with it (2.1.12).
   And contracts about to freeze with bare strings, no version, no panic policy and no migrations (2.1.18 to 2.1.20, 2.1.25).
   Split the document by lifetime, put the real core behind a development transport, and settle the contract's shape now.

On the four technical bets, in a line each (2.4).
Tauri with system webviews: right for macOS now, unmeasured on Linux, with bundled Chromium under Tauri 3 as the way out; do not start a native rewrite.
The WASM component runtime: sound as a later transport, wrong as the definition of a public API in 2027.
One HTTP/2 connection and Table watches: the right default, to become a few counted connections and a table with joined side columns.
kube-rs: a low risk; the cost is the client stack Twigo already owns, part of which should go upstream.

Section 3 orders the work, and section 4 lists the seventeen decisions that are the maintainer's alone.

## 2. Findings by area

The five areas of the brief, in its order.
Findings are numbered within each area, and the backlog in section 3 points back to them.

### 2.1 Inconsistencies and drift

#### The safety path, end to end

**2.1.1 Every Kubernetes request passes the gate, and no path goes around it today.**
Fact (verified).

- Every client comes from `Clients::new`, which takes the context's gate (`crates/twigo-kube/src/client.rs:167`), and both stacks carry it at the top and again above the socket (`crates/twigo-kube/src/client.rs:130-149`).
- Other actors get clients over the same stacks with their own gate (`crates/twigo-kube/src/client.rs:286-288`), and the policy proxy sends through those (`crates/twigo-core/src/proxy.rs:112`, `crates/twigo-core/src/proxy/forward.rs:60`, `crates/twigo-core/src/proxy/splice.rs:103`).
- Outside tests and eleven calls in the examples that record fixtures and probe memory, `Gate::unrestricted()` has one caller, the bench's churn tool (`bench/harness/src/churn.rs:131`), and `Clients::over` compiles only under `test` or the `test-util` feature (`crates/twigo-kube/src/client.rs:221-236`).
- A grep for write verbs at `52d2c28f` finds the UI's own writes only in `crates/twigo-core/src/actions.rs` and under `actions/`; beyond them the proxy forwards a child's requests, the broker sends their dry runs (`crates/twigo-core/src/approvals/detail.rs:165-181`), and the hub's one POST is a SelfSubjectAccessReview (`crates/twigo-cache/src/hub.rs:602`).
- Three things start processes, all outside the gate by design: the local terminal (`crates/twigo-sessions/src/terminal/spawn.rs:35`), exec credential plugins (`crates/twigo-kube/src/credentials/run.rs:163`) and the login-shell probe (`crates/twigo-env/src/lib.rs:271`).
- The side doors are closed in Rust: `object_values` answers only for a ConfigMap (`crates/twigo-core/src/objects.rs:129-141`), `logs_download` writes only where a native dialog chose (`apps/desktop/src-tauri/src/main.rs:490-524`), and `url_open` takes only https and local http (`crates/twigo-core/src/lib.rs:1050-1068`).

The claim "every write goes through one policy gate" holds.
What follows is about what that gate decides, which is less than the document's words promise.

**2.1.2 The lock's own setter has no friction and leaves no trace.**
Fact (verified); the judgement that it matters: confidence high.

- One IPC command sets a context's mode: `context_mode_set` (`apps/desktop/src-tauri/src/main.rs:174-177`) calls `Core::set_context_mode` (`crates/twigo-core/src/lib.rs:324-333`), which calls `Policy::set_mode` (`crates/twigo-policy/src/policy.rs:374-387`).
  Only an admin's policy file refuses it (`crates/twigo-policy/src/policy.rs:375`).
- The person's choice outranks `twigo.readOnly` in the kubeconfig, the provider's mark and the Production default (`crates/twigo-policy/src/policy.rs:243-263`).
- A file can lower the lock as well: `twigo.readOnly: false` in a kubeconfig yields `read-write` ahead of the provider's mark and the Production default (`crates/twigo-kube/src/kubeconfig.rs:414-416`, `crates/twigo-policy/src/policy.rs:246-253`), and any process of the user, an agent's shell included, can write that file.
- A delete of one pod is planned, shown, confirmed and checked in Rust (`crates/twigo-core/src/lib.rs:412-463`).
  Turning a Production context from `read-only` to `read-write` is one call that Rust accepts from any page state, with nothing typed and nothing checked.
- The audit log has four events and none of them is a mode change, an unlock or a plugin trust (`crates/twigo-policy/src/audit.rs:30-70`).

The command-bus decision exists because "a confirmation drawn only by the webview is a promise" (`docs/decisions/command-bus.md:21`).
The mode change is exactly such a promise, and it guards everything else.
Recommendation: make the mode, the environment type, the unlock and plugin trust actions of the bus, with friction that Rust names (the context's name typed to leave `read-only`), and an audit event each.
A lock that came from the kubeconfig or a provider should stay visible as overridden, in the chip and in the log.
Kubeconfig metadata should only tighten: a `readOnly: false` that would lower a stricter default waits for the person's yes in the app.
Effort S.

**2.1.3 The gate has no notion of a grant, so the actors of M3 inherit `read-write`.**
Fact (verified); the judgement: confidence high.

- `Actor::decide` passes every actor's writes and execs in a `read-write` context, the `Mcp`, `Agent` and `Extension` actors included (`crates/twigo-policy/src/actor.rs:52`).
  The one exception is a write to a Secret, which an agent and an extension without the `secrets` grant are refused in every mode (`crates/twigo-policy/src/policy.rs:351-357`, `crates/twigo-policy/tests/gate.rs:892-916`).
- A context nobody marked is `read-write` (`crates/twigo-policy/src/policy.rs:262`), by the document's rule that nothing guesses a type from a name (`docs/ARCHITECTURE.md:1980`).
- The document promises grants per client and context with `none` as the default, capped by the mode (`docs/ARCHITECTURE.md:2074-2078`), and the Rule of Two in `read-write` contexts (`docs/ARCHITECTURE.md:1925`).
  Neither exists in the policy crate; `TODO.md:63` says so for the Rule of Two.
- `Actor::Mcp` and `Actor::Extension` are never constructed outside tests, and `Actor::Helm` and `Actor::Agent` only appear in a guard (`crates/twigo-core/src/proxy.rs:171`).
  Their rules, such as "MCP reads Secrets" (`crates/twigo-policy/src/actor.rs:68`), were written and tested before any caller existed.

So on the day the MCP server or an agent's proxy kubeconfig ships, a default context lets an agent write anything but a Secret with no approval, unless that work also changes the gate.
Recommendation: before any M3 actor is wired, add the grant to the decision itself: `decide(class, mode, grant)`, where a non-UI actor never gets better than `guarded`, whatever the mode, and `none` refuses reads too.
Add the row to `crates/twigo-policy/tests/gate.rs` first, as the policy rule asks (`.claude/rules/policy.md`).
Section 2.3 gives the full model.
Effort M.

**2.1.4 The audit log misses what a reviewer would look for first.**
Fact (verified); the judgement: confidence medium.

- The gate logs only requests of the `Write` class (`crates/twigo-policy/src/audit.rs:138-140`).
  An exec, an attach, a port-forward and a read of a Secret through the gate leave no line unless they needed an approval (`crates/twigo-core/src/approvals.rs:600`) or ran as a bus command (`crates/twigo-core/src/lib.rs:467-474`).
- A terminal that an admin's policy file sends through the proxy in a `read-write` context can `exec` into a pod and read every Secret, and the log holds nothing of it.
- Mode changes, unlocks and plugin trust are not logged (2.1.2).
- The file grows without bound (`TODO.md:60`), and any process of the user can rewrite a file of mode 0600 in the app-data directory (`docs/ARCHITECTURE.md:1973`); the document says only that "the log records, it guards nothing" (`docs/ARCHITECTURE.md:1976`).
- Twigo's own requests carry no `User-Agent`: the stacks add none (`crates/twigo-kube/src/client.rs:130-149`) and kube-client 5.0.0 sets none (its source in the cargo registry has no `USER_AGENT`).
  The cluster's audit log, the one record an attacker on the laptop cannot edit, therefore cannot tell Twigo's writes from any other client's.

"Audit" is named as a selling point; today it is a write log.
Recommendation: log every class but plain reads for every actor but the UI, log the lock's changes, rotate by size, and send `User-Agent: twigo/<version> (<actor>)` on every request.
The last is three lines and worth doing this week.
Effort S to M; the `User-Agent` alone is S.

**2.1.5 A server dry run is harmless to the gate in every mode, also where the approval broker itself does not trust it.**
Fact (verified); whether a real server ignores `dryRun`: not verified.

- The gate passes the `DryRun` class always (`crates/twigo-policy/src/actor.rs:50`), for any group but the two review groups (`crates/twigo-policy/src/attributes.rs:313-319`).
- The approval broker refuses to dry-run against a group that an APIService hands to another server, because "an aggregated server that ignored `dryRun` would perform the write" (`crates/twigo-core/src/approvals/detail.rs:6-7` for the words, `210-246` for the check).
- The apply preview has no such check (`crates/twigo-core/src/actions/apply.rs` names no APIService), so in a `read-only` context Twigo itself sends a dry-run PATCH to aggregated servers, and so does `kubectl apply --dry-run=server` through the proxy.
- The document admits the gap: "Whether every aggregated API server honours it is not verified" (`docs/ARCHITECTURE.md:1851`).
  A web search on 2026-11-14 found no report of a server that ignores it; KEP-576 defines dry-run inside kube-apiserver, in admission, webhooks and the storage layer, and says nothing of aggregated servers ([KEP-576](https://www.kubernetes.dev/resources/keps/576/), accessed 2026-11-14).

Two code paths answer the same question differently.
Recommendation: move the broker's check into the classifier's input (a `DryRun` to a group with `spec.service` is a `Write`), so `read-only` means the same thing on every path.
Effort S.

**2.1.6 "Enforced in Rust" still rests on an honest webview; the document should say so and the webview should be hardened to match.**
Fact (verified); the judgement: confidence medium.

- A plan carries the text to type (`crates/twigo-ipc/src/action.rs:94-99`, `131-140`) and the webview sends it back (`crates/twigo-ipc/src/action.rs:143-148`); Rust compares the two (`crates/twigo-core/src/lib.rs:455-460`).
  That stops a stale page, a second window and a bug, as the decision says, and not a script running in the page.
- The page also names the plugin digests to trust (`apps/desktop/src-tauri/src/main.rs:650-653`, `crates/twigo-core/src/trust.rs:62-69`) and sets modes (2.1.2).
- So the webview is the trust root for everything the UI actor may do, and `docs/ARCHITECTURE.md:2141` is right that "an XSS in the webview would reach every cluster".
- What protects it is sound but thin: a CSP without `base-uri`, `form-action` and `frame-ancestors` (`apps/desktop/src-tauri/tauri.conf.json`), no navigation handler in the builder (`apps/desktop/src-tauri/src/main.rs:762-915` registers none), and no HTML sinks or links in the packages (a grep for `innerHTML`, `dangerouslySetInnerHTML` and `href=` at `52d2c28f` finds none outside test files).
- The shipping entry loads the mock backend whenever `isTauri()` is false (`apps/desktop/src/main.tsx:20-31`), and no build flag removes it (`apps/desktop/vite.config.ts`).
  A release in which that check failed would show fake clusters named like production instead of an error.

Recommendation: add the three CSP directives, deny navigation away from the app's origin, load the mock only in a development build, and add a lint that fails on a new HTML sink.
State in 6.4 that friction guards against mistakes, and that the page is trusted.
Effort S.

#### Documents against code

**2.1.7 ARCHITECTURE.md cannot tell a reader what exists.**
Fact (verified).

- Its status line still reads "M0 in progress, steps 1 to 5 done, steps 6 and 7 in review, 2026-11-01" (`docs/ARCHITECTURE.md:7`), while `git log` shows M2's write path merged up to #45.
- `README.md:19-20` says that editing, exec and port-forward "come next"; they merged between 2026-11-09 and 2026-11-13 (`git log`, commits `22a71b09` to `02e325ae`).
- `README.md:37` sends readers to `docs/bench.md` for "the latest results"; those are four runs of 2026-11-07, three of them passing (`docs/bench.md:126-146`), while `TODO.md:29` records the core at 161 to 166 MB against its 150 MB budget on 2026-11-14.
- The document describes, in the present tense and at the same level of detail as shipped code, parts that have no code:

| Described                                                                                  | Where                                    | In the repository at `52d2c28f`                                                                                                                        |
| ------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Extension host, WIT API, MCP server, Helm decoding                                         | `docs/ARCHITECTURE.md:196-199`, 5.3, 6.6 | Four crates of one empty line each; no `wasmtime`, `rmcp` or `reqwest` dependency in any manifest                                                      |
| `extensions/` with a fixture extension in CI                                               | `docs/ARCHITECTURE.md:206`, `1568`       | No such directory                                                                                                                                      |
| Settings files in layers, context overrides, live reload                                   | `docs/ARCHITECTURE.md:1331-1342`         | Modes live in the state store behind an `@todo` (`crates/twigo-policy/src/policy.rs:42`)                                                               |
| Keybindings editor, `keybindings.json`, Default and k9s keymaps                            | `docs/ARCHITECTURE.md:1505`, `1523-1524` | A resolver, a dispatch service and a layout mapper (`packages/workbench/src/keybindings/`); no editor, no reader of `keybindings.json`, no keymap code |
| Projection watches for custom JSONPath columns                                             | `docs/ARCHITECTURE.md:413-416`           | No JSONPath evaluator in `crates/`                                                                                                                     |
| A space in a new window, ⌘⇧N                                                               | `docs/ARCHITECTURE.md:746`               | One window; the capability names only `main` (`apps/desktop/src-tauri/capabilities/main.json`)                                                         |
| An openssl stack for legacy clusters                                                       | `docs/ARCHITECTURE.md:1817`              | No openssl in any manifest                                                                                                                             |
| Bench replays: 30k pods in all namespaces, packet loss                                     | `docs/ARCHITECTURE.md:680-686`           | Not in `bench/` nor in `docs/bench.md`                                                                                                                 |
| Budgets at 20k and 50k pods                                                                | `docs/ARCHITECTURE.md:650-659`           | Never run (`docs/bench.md:343-344`)                                                                                                                    |
| Signed updater artifacts, notarization, `cargo deny`, `pnpm audit`, an SBOM, budgets in CI | `docs/ARCHITECTURE.md:2153-2157`, `2175` | No updater dependency, no release workflow, none of the checks in `.github/workflows/`                                                                 |

Recommendation: give every section of the document a one-word status (`built`, `partly`, `planned`) at its heading, held by the pull request that changes it, and fix the two stale lines today.
Effort S.

**2.1.8 The document that "fixes the architecture" has become the implementation log, and the rules bind every change to it.**
Fact (verified); the judgement: confidence high.

- It holds 2,262 lines and 341 KB, about 48,900 words; section 4.6 alone has 13,745 words (`wc` at `52d2c28f`).
- Next to invariants it records the bytes a mutex allocates per context (`docs/ARCHITECTURE.md:558-562`), the pixel widths of a chip beside two, five and six tabs (`docs/ARCHITECTURE.md:1230`), and the stacking of toasts in sonner 2.0.8 (`docs/ARCHITECTURE.md:1279-1288`).
- The code rule says "Follow `docs/ARCHITECTURE.md`" and "change the document in the same PR" (`.claude/rules/code.md`), so 34 commits touched it in 15 days (`git log -- docs/ARCHITECTURE.md`).
- Nobody can read it before a change: at roughly four characters a token it costs about 85,000 tokens, and a person needs most of a working day.
- The evidence rule (`docs/decisions/evidence.md:10`) is why the numbers are there; the rule is good, their place is not.

Recommendation: split it by lifetime.
Keep `ARCHITECTURE.md` to what must stay true for a year: processes, crate and package boundaries, the data path, the gate, the IPC contract, the budgets, in about 500 lines.
Move each feature's design to `docs/design/<feature>.md` (logs, terminal, port-forward, apply, metrics), which a rule with `paths:` loads only for that code.
Move measurements to the commit message or `docs/measurements/`, linked from the sentence they support.
Effort M, mechanical.

**2.1.9 "The workbench knows nothing of Kubernetes" is not what the code does.**
Fact (verified); the judgement: confidence medium.

- The decision's table says so (`docs/decisions/frontend-architecture.md:12`), and 2.3 repeats that the workbench "only learns about Kubernetes through registries" (`docs/ARCHITECTURE.md:244`).
- The import rule holds: nothing in `packages/workbench` imports `@twigo/kube` (`eslint.config.js:23-35`, and a grep).
- The concepts do not: spaces carry namespaces (`packages/workbench/src/spaces/store.ts:37-38`), colours come from the kubeconfig (`packages/workbench/src/spaces/colors.ts:45`), modes name `twigo.readOnly` (`packages/workbench/src/spaces/modes.ts:97-98`), the confirm dialog reads `plan.kubectl` and an object's namespace (`packages/workbench/src/operations/ConfirmHost.tsx:36-42`), and exec-plugin trust and approvals live there too (`packages/workbench/src/credentials.ts`, `packages/workbench/src/approvals/`).

The code is right and the decision is wrong.
D1 made Twigo one Kubernetes app, and a shell that pretends to be domain-free would only add a layer.
Recommendation: change the decision's words to "the workbench knows contexts, modes and sessions, and no kinds", and stop treating a NATS extension as the test of the shell.
Effort S.

**2.1.10 The agent rules load a manual into every session.**
Fact (verified).

- `.claude/rules/checks.md` is 33,650 bytes, and one list item of it, the mock's scenarios, is 7,908 characters on a single line (line 9).
- It has no `paths:` front matter, unlike eight of its ten neighbours, so it loads for any work in the repository; it loaded into this review's context as soon as a file was read.

Recommendation: move the scenarios beside the mock (`packages/protocol/src/mock/README.md`), split the commands by crate into rules with `paths:`, and keep `checks.md` to what applies everywhere.
Effort S.

#### The Rust–TypeScript boundary

**2.1.11 The wire types and the command lists are generated or held by a test.**
Fact (verified).
`packages/protocol/src/generated.ts` is rendered from `crates/twigo-ipc` and a test fails on a stale copy (`docs/decisions/ipc-codegen.md:10`); the four hand-kept command lists are compared by `apps/desktop/src-tauri/tests/commands.rs:22-46`.
This part is sound, though the test compares names only, so a handler's types are tied to its command by hand.

**2.1.12 The mock backend is a second implementation of the core, kept in step by hand.**
Fact (verified); the judgement: confidence high.

- `packages/protocol/src/mock` holds 10,913 lines of TypeScript that is not tests and 7,443 lines of tests (`find | wc` at `52d2c28f`): a command bus with the friction table (`mock/bus.ts`, 1,694 lines), a query engine (`mock/query.ts`, `mock/selector.ts`), a log buffer with level detection (`mock/logs.ts`, `mock/logview/`), port-forward states (`mock/forward.ts`, 754 lines), metrics states, approvals, terminals and shells.
- That is a quarter of the hand-written TypeScript that is not tests (10,913 of 44,917 lines).
- The decision asks for it: "the mock backend's bus mirrors each action and the friction table" (`docs/decisions/command-bus.md:16`).
- Only two areas share behaviour cases with Rust: `packages/protocol/src/query-cases.json` and `log-cases.json`.
  A Rust test also writes and checks the mock's recorded overviews and Reveal answers (`crates/twigo-describe/tests/overviews.rs:85-134`).
  The logic of the bus, friction, forwards, metrics, approvals and terminals can drift with no test to notice, and the design reviews and component tests that run on the mock then approve behaviour the app does not have.
- `.claude/rules/checks.md` line 9 lists some forty `?scenario=` switches, each a branch of that second implementation.
- It has already diverged where no case is shared: for a port named `http-metrics` Rust ranks the word "metric" first and picks another port by default (`crates/twigo-core/src/forward/ports.rs:109-124`), while the mock ranks the prefix "http" first and picks that one (`packages/protocol/src/mock/forward.ts:186-190`).
  The TypeScript audit compared friction, sort, filter and counts and found them equal, which is where cases are shared or tests are dense (not re-checked by me).

Every backend change is written twice, and the second copy is the one the owner looks at.
Recommendation: stop mirroring logic.
Run the real core behind a second, development-only transport (a WebSocket to a headless core on kwok or on the fakes Rust already has) for interactive review and browser tests; keep a scripted fake of a few hundred lines and recorded traffic for component tests; delete the mock's modules as they are replaced, the bus first.
The contract already allows it: the webview talks to Rust through two methods (`packages/protocol/src/backend.ts:17-27`).
Until then, where a rule must exist on both sides, run both from one case file, as the query cases do.
Effort M to L, started before the contracts freeze and finished after the beta.

**2.1.13 The wire error is also the core's error type, and its nine kinds are all a machine can read.**
Fact (verified); the judgement: confidence medium.

- `IpcError` is `{ kind, message, blocked? }` with nine kinds (`crates/twigo-ipc/src/error.rs:8-52`).
- It is built at 159 call sites outside tests, 17 of them with a literal `Internal` (a grep for `IpcError::new(`), in crates far below the IPC: the label parser (`crates/twigo-cache/src/view/labels.rs:73`), the forward's causes (`crates/twigo-sessions/src/forward/cause.rs:72`), kube's errors (`crates/twigo-kube/src/errors.rs:12`).
- The crates differ: `twigo-kube` derives 14 error types with thiserror and `twigo-core` three, while `twigo-sessions` has one enum, for a bind, and `twigo-describe` none.
- The message is written for a person, so whatever a caller must branch on beyond the kind lives in the words.

For a webview that is enough.
An MCP client and an extension need to tell "stale, reload" from "conflict, another manager owns it" without reading English, and M3 freezes both contracts.
Recommendation: add a stable `code` (a closed enum per area, generated to TypeScript like the rest) beside `kind` before the MCP server reuses these types, and let the lower crates return their own enums.
Effort M.

#### Between crates

**2.1.14 The same mechanism is written three times, each with its own tests.**
Fact (verified).

- The seq-and-ack flush loop (one unacknowledged batch, a tick, coalesce while waiting) exists in the list batcher (`crates/twigo-cache/src/batcher.rs:128-191`), the open objects (`crates/twigo-core/src/objects.rs:327-529`) and the logs (`crates/twigo-sessions/src/logs/session.rs:218-264`).
  The byte-counted flow control, by contrast, exists once and is shared by shells and terminals (`crates/twigo-sessions/src/flow.rs:11-74`).
- The hub's backoff, "0.5 to 5 s with jitter", is configured in three places, once as `RETRY_WITHIN / 2` and twice as a literal 2,500 ms (`crates/twigo-cache/src/upstream.rs:231-239`, `crates/twigo-sessions/src/logs/stream.rs:243-251`, `crates/twigo-sessions/src/forward.rs:553-560`).

Recommendation: one `Flusher` in `twigo-ipc` or a small crate of its own, and one `backoff::ui()`; the MCP server and the extension host will otherwise bring a fourth copy of each.
Effort S.

#### Tests and the bench

**2.1.15 What the budgets claim and what is checked.**
Fact (verified).

| Claim                                                  | Where                          | What is checked                                                                                                |
| ------------------------------------------------------ | ------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| "Budgets are numbers that a harness checks"            | `docs/ARCHITECTURE.md:35`      | By hand, on one Apple M4 Max with 48 GB (`docs/bench.md:130`); CI does not run it (`docs/ARCHITECTURE.md:678`) |
| Targets at 5k and 50k pods                             | `docs/ARCHITECTURE.md:652-659` | Only 5k; 20k and 50k never ran (`docs/bench.md:343-344`)                                                       |
| Core RSS under 150 MB                                  | `docs/ARCHITECTURE.md:657`     | 161 to 166 MB since the metrics step (`TODO.md:29`)                                                            |
| Webview memory under 300 MB                            | `docs/ARCHITECTURE.md:658`     | Counts resident size without WebKit's GPU process, which holds 263 MB (`docs/bench.md:140-142`, `309-311`)     |
| Idle CPU                                               | `docs/ARCHITECTURE.md:659`     | The target moved from 1 % to 2 % when 1 % judged noise (`docs/bench.md:183-187`)                               |
| Visible CPU                                            | `docs/ARCHITECTURE.md:675`     | 5.8 to 13.7 % of a core at 100 changes/s, shown and not judged (`docs/bench.md:211`)                           |
| First paint under 1 s "after the space connects (LAN)" | `docs/ARCHITECTURE.md:654`     | Loopback to kind; the clock starts when the list opens, after discovery began (`docs/ARCHITECTURE.md:668`)     |
| Linux                                                  | `docs/ARCHITECTURE.md:2201`    | Nothing measured on WebKitGTK (`docs/bench.md:346-347`)                                                        |

Three consequences.
The app at 5,000 pods holds about 650 MB across its processes (146 and 245 MB resident, and 263 MB of footprint in WebKit's GPU process, `docs/bench.md:139-142`), which is not the "weight" advantage the first paragraph of the document claims over Electron clients until someone measures those the same way.
The number a new user feels first, launch to the first useful rows, has no budget and no measurement: the catalog follows kubectl's files only once the login shell's environment has resolved or failed (`crates/twigo-core/src/lib.rs:975-991`), which can take up to its 10 s timeout (`crates/twigo-env/src/lib.rs:38`), and no context shows before that.
And every number comes from one top-end laptop, an Apple M4 Max with 48 GB (`docs/bench.md:130`).
Recommendation: before the beta, add a launch-to-first-rows budget, run the harness at 50k once, measure on an 8 GB machine and on one Linux desktop, and publish Lens, Freelens and k9s beside Twigo with the same sampler.
Effort M.

**2.1.16 CI never builds the app for the platform it is measured and debugged on.**
Fact (verified).

- The app builds only on Ubuntu (`.github/workflows/rust.yml:80-105`); the macOS job runs the tests of two crates (`.github/workflows/rust.yml:64-76`); the frontend tests run on Ubuntu in jsdom (`.github/workflows/ci.yml:16-28`).
- The WebKit behaviours the document records were found by hand, most in a real WKWebView (`docs/ARCHITECTURE.md:1004-1007`, `1067-1069`) and some in Playwright's WebKit (`docs/ARCHITECTURE.md:810`, `815`, `1230`), and nothing repeats those checks.
- No workflow builds for Windows, and the Unix-only dependencies of the terminal, the environment probe and the credential runner are unconditional (`crates/twigo-sessions/Cargo.toml:22-24`, `crates/twigo-env/Cargo.toml:13`, `crates/twigo-kube/Cargo.toml:32`).
  D2's "only CI, signing and the test matrix for Windows are deferred" (`docs/ARCHITECTURE.md:18`) understates it: those three crates need a port (not verified by a Windows build).
- Actions are pinned by tag, not by commit (`.github/workflows/ci.yml:20-21`), and no job runs `cargo deny` or an audit.

Recommendation: a macOS job that builds the app, and a `cargo check --target x86_64-pc-windows-msvc` job that is allowed to fail until it does not, so the Windows debt stops growing unseen.
Effort S.

#### What fast generation left behind

**2.1.17 About half of the repository is tests, and the pull requests are too large to bisect.**
Fact (verified); the judgement: confidence medium.

- TypeScript in the `ui`, `workbench`, `kube` and `protocol` packages: 44,917 hand-written lines outside test files, `generated.ts` left out, and 39,646 in test files (`find | wc` at `52d2c28f`).
- Rust: of 120,407 lines 49,228 are in test files (`tests/` and the `tests` modules' files under `src`) and about 10,400 in inline test modules, half in all (a script over `crates`, `apps/desktop/src-tauri` and `bench`).
  In `twigo-core` 21,357 of 41,159 lines are test files.
- 1,381 Rust tests and about 1,460 Vitest cases; no lint is silenced anywhere (no `#[allow]`, no `eslint-disable`, no `@ts-expect-error`), which is rare and worth keeping.
- The nine feature pull requests from #36 to #45 each landed as one squash commit of 5,264 to 38,419 inserted lines (`git log --shortstat`).
  `git bisect` and `git revert` therefore work at the size of a whole feature.
- All 38 commits on `main` have one author (`git shortlog`), and the brief for this review says the code was written with heavy AI assistance.

The tests are the project's memory, since no person can have read some 200,000 lines of Rust and TypeScript in fifteen days (120,407 and 88,421 lines, `find | wc` over `crates`, `apps`, `bench` and `packages` at `52d2c28f`).
That makes their quality the real bus factor, and their volume a cost: a behaviour change touches hundreds of assertions, and tests that fail once and pass on a rerun already take time (`TODO.md:125-127`).
Recommendation: keep squash merges but land a feature as several pull requests along its natural seams (contract, core, webview), and spend one pass per milestone deleting tests that pin lines and not behaviour.
Effort M.

#### The core: failure, state and identity

**2.1.18 There is no policy for panics, and five unrelated loops share one task.**
Fact (verified by reading; nothing was run, and no trigger for a first panic was found).

- `Core::run` joins the catalog's sources, the state, the terminals' offers, the unlocks' expiry and the forwards' mode checks in one future (`crates/twigo-core/src/lib.rs:1019-1025`).
- The offers loop re-raises a panic of its blocking task on purpose (`crates/twigo-core/src/terminal.rs:144-149`).
  If it dies, the other four die with it, the expiry of unlocks among them (`crates/twigo-policy/src/policy.rs:459-477`): the gate still reads the clock, but nothing tells the windows and the sessions that a context relocked.
- A plan whose run panics never ends: the spawned task records the end and frees the plan only after `run` returns (`crates/twigo-core/src/lib.rs:489-511`).
- No crate sets a panic hook or catches an unwind (a grep for `set_hook` and `catch_unwind` finds one hit, in a test of the bench harness), and there is no log for a panic to land in (2.5.1).

A tokio task that panics does not take the process down, as `docs/ARCHITECTURE.md:168` says; it takes its duties down silently.
Recommendation: split `Core::run` into supervised tasks, add a panic hook that writes to the log, and let a panicked run end its plan as failed.
Effort S to M, before the beta.

**2.1.19 The person's locks fail open; the admin's fail closed.**
Fact (verified).

- A `state.json` of another version, or one that does not parse, is moved aside whole and the store starts empty (`crates/twigo-core/src/state.rs:38-40`, `409-430`).
- That file holds the mode and the type a person chose for each context (`crates/twigo-core/src/state.rs:45`), so after a version bump, a downgrade or a damaged file a context the person made `read-only` is whatever its kubeconfig says, `read-write` by default (`crates/twigo-policy/src/policy.rs:262`), with one line on stderr.
- An unreadable policy file, by contrast, locks every context (`docs/ARCHITECTURE.md:1339`).
- "Before users exist there are no migrations" (`docs/ARCHITECTURE.md:1360`) stops being true on the day of the beta, and wire types are written into the file as they are (`crates/twigo-policy/src/policy.rs:43-50`), so a serde rename changes the format with no version bump.

Recommendation: a migration and a fixture for every released version of every file a person keeps; the protective choices in a file of their own that reads closed; structs for disk apart from the wire's.
Effort M, before the first beta build, since a format is frozen the day someone has a file.

**2.1.20 Only a convention keeps writes inside the bus, and only a string says who asked.**
Fact (verified); the judgement: confidence high.

- `Clients.api` is public and can send any request (`crates/twigo-kube/src/client.rs:57`), and in `guarded` the gate passes the UI's writes unasked (`crates/twigo-policy/src/actor.rs:54-58`).
  That the UI's writes come only from `crates/twigo-core/src/actions.rs` and `actions/` is a grep of mine, not a type.
- A window is `window: &str` in 59 signatures of `twigo-core` (a grep), and its lifetime is kept four ways: a generation per window (`crates/twigo-core/src/subscriptions.rs:22-27`), the bus's own map of windows (`crates/twigo-core/src/bus.rs:210`), follower maps (`crates/twigo-core/src/approvals.rs:46`, `crates/twigo-core/src/forward.rs:164`), and tasks per webview in the shell (`apps/desktop/src-tauri/src/main.rs:68-82`).
  M3's callers, an MCP session and an extension, have no window.
- Identifiers are bare: a context's "connection" is a `u64`, a space's id equals its context's name, and commands take a `String` that is a context's name in some (`crates/twigo-ipc/src/command.rs:75`, `159`) and a space's id in others (`crates/twigo-ipc/src/command.rs:172`, `192`).
  Multi-context spaces end that equality, and every mix-up compiles today.
- Wire variants that nothing produces are about to freeze with the contract: `ModeSource::Provider` (`crates/twigo-core/src/catalog.rs:96` always sets none) and the grant refusal of an actor that does not exist (2.1.3).
- `Policy::unlock_for` unlocks for any length and is public (`crates/twigo-policy/src/policy.rs:410`), as is `Gate::unrestricted` (`crates/twigo-policy/src/gate.rs:43`); that the app calls the first only with its fixed length and the second never is prose.

Recommendation, before the contracts freeze: an `Origin` handle (a window, an MCP session, an extension) that owns what it keeps and follows; `ContextName`, `SpaceId` and `Connection` newtypes from the wire down; write-capable clients handed only to a plan's run, with every other client refusing writes at its gate; the two test seams behind a feature the app never enables.
Effort M to L, mechanical.

**2.1.21 The three flush loops differ where the protocol shows, and a lost acknowledgement stalls a subscription for good.**
Fact (verified).
All three accept only an acknowledgement equal to the outstanding `seq` and none has a timeout or a resync (`crates/twigo-cache/src/batcher.rs:159`, `crates/twigo-core/src/objects.rs:360`, `crates/twigo-sessions/src/logs/session.rs:245`); no test covers a lost one.
An open object's loop also parses the object's JSON again on each pass (`crates/twigo-core/src/objects.rs:398-400`); what that costs is not measured.
Recommendation: the one flush kernel of 2.1.14, with the lost-acknowledgement behaviour decided and written into the IPC contract.

**2.1.22 The tests are sound where sampled, and thin in four places.**
Judgement (confidence: medium) for the sample; Fact for the gaps.

- Sound: the bus's friction, the proxy's token and host checks by what the server saw, the hub's backoff and relist, the batcher's coalescing, the credential runner's single flight, the log resume.
- Thirteen test files bind a listener for a server of their own (a count of `TcpListener::bind` in test code), and three in-memory fakes each implement list and watch (`crates/twigo-cache/src/fake.rs`, `crates/twigo-sessions/src/logs/fake.rs`, `crates/twigo-sessions/src/forward/fake.rs`).
  The cache's fake ignores selectors when it lists (`crates/twigo-cache/src/fake.rs:484-506`), so "an object by name" is proven only by the live tests.
- A drain's and a delete's run are tested only live, behind `#[ignore]`.
- Nothing tests a panic, a lost acknowledgement or a `410` answered as a status.
- A fixed 300 ms wait before a positive assertion (`crates/twigo-core/src/tests.rs:174-176`) is the likely cause of the flake `TODO.md:35` records (Bet, confidence medium).
- 41 integration test files and 13 examples each link the stack, which is why the app's build needed a runner of its own (`.github/workflows/rust.yml:78-79`).

Recommendation: one test-support crate with one fake API server, one `TestCore` and one live `Cluster`; one integration binary per crate.
Effort M.

#### The webview: requests, errors and the contract

**2.1.23 A viewer's cursor issues access reviews per row.**
Fact (verified) for the path; the rate: Bet (confidence: medium).

- Every change of the selected row asks for its capabilities at once, with no pause (`packages/kube/src/list/ListEditor.tsx:126-148`).
- Where the answer for the whole resource is no, Rust asks again by name (`crates/twigo-cache/src/hub.rs:547-563`), one SelfSubjectAccessReview per verb and row.
- A no is kept for 30 s (`crates/twigo-cache/src/cluster.rs:16`), and the webview re-asks while any answer is no (`packages/kube/src/capabilities.ts:152-156`).

So the person with the least access, a viewer, sends the most requests: holding `j` over a hundred rows is some hundreds of POSTs, each one a line in the cluster's audit log.
Recommendation: wait about 150 ms after the cursor rests; better, ask by name only when a command is about to run, or ask one SelfSubjectRulesReview per namespace.
Effort S, before the beta.

**2.1.24 A render error outside an editor's body takes the whole workbench down, and the restored layout repeats it.**
Fact (verified) for the path; that something will throw there: Bet (confidence: medium).
The error boundary wraps the editor's component only (`packages/workbench/src/parts/EditorArea.tsx:243-245`); a group's actions (`packages/workbench/src/parts/EditorArea.tsx:250-261`) and the watermark (`packages/workbench/src/parts/EditorArea.tsx:318-322`) render outside it, so the next boundary is the root's (`packages/workbench/src/WorkbenchView.tsx:9-11`).
Since the layout is restored at start, the same tab throws again.
Recommendation: a boundary around every contributed surface; it matters more once extensions contribute them.
Effort S, before the beta.

**2.1.25 The contract's shape has five things to settle before it freezes.**
Fact (verified); the judgement: confidence high.

- Ten commands take a bare `String` as their request and ten take nothing (`crates/twigo-ipc/src/command.rs`, a count of `type Request`), so no field can be added to them without a break, and the protocol has no version and no handshake.
- 64-bit integers are typed `number` (`crates/twigo-ipc/src/typescript.rs:26`).
- The webview re-derives meaning from printed text: a pod's health is a table in TypeScript and the same table in Rust (`packages/kube/src/columns.ts:75-98`, `crates/twigo-describe/src/pod.rs:588-600`), and "cordoned" and "suspended" are read from a cell's words (`packages/kube/src/rowState.ts:14-37`).
  An MCP client would have to do it a third time.
- Context keys and `when` expressions are about to become a public surface with no registry: an unknown key reads false silently (`packages/workbench/src/contextkey/when.ts:259-260`).
- The lint that the document relies on for exhaustive switches (`docs/ARCHITECTURE.md:862`) accepts a `default` branch as exhaustive (`eslint.config.js:168-171`), so a new variant of a state passes unseen, and the handlers' types are tied to the command table by name only (2.1.11).

Recommendation: struct requests everywhere, a `hello` that carries a version and the limits, an integer policy, tone and typed facts on rows from Rust, a typed registry of context keys with the `when` and key grammars written down and held by shared cases.
Effort M, before the beta.

**2.1.26 Frontend tests: the editor is always faked, and nothing checks the accessibility the document claims.**
Fact (verified).

- Monaco is replaced by a fake in the editor's tests, and one test's name promises behaviour it does not check: "completion rises as a key is typed" asserts two options handed to the fake (`packages/kube/src/edit/YamlEditor.test.tsx:135-141`).
- The contrast ratios and focus rules of `docs/ARCHITECTURE.md:1380-1384` are checked by no test or tool (a grep of the test files for contrast and axe finds none).
- 53 of 152 test files name the mock, and about 70 run on it once the shared helpers that build it are counted (a grep; the second figure is the verification pass's), so they prove the second implementation.

Recommendation: a browser smoke test on the real core once it has a development transport (2.1.12), with an accessibility pass in it.
Effort M, with the mock's replacement.

#### The documents themselves: decisions and rules to change

**2.1.27 Where the document is wrong, outdated or in its own way.**
Judgement (confidence as given in the section each row points to).

| Decision or rule                                                                                                | What is wrong with it                                                                                                                             | Change it to                                                                                                                            | See              |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| The opening goal, "match Lens feature for feature" (`docs/ARCHITECTURE.md:4`)                                   | That gap closed in 2025; it is also the risk the document names itself (`docs/ARCHITECTURE.md:2206`)                                              | One position: triage for the operator of many clusters, from the keyboard, safely                                                       | 2.2              |
| Principle 1, "Performance is the product", with budgets "a harness checks"                                      | Checked by hand, on one laptop, at one size, on loopback; three budgets were loosened or left unjudged                                            | Keep it as an engineering rule; add budgets for launch to first rows, total memory and a WAN profile; let CI guard the Rust-side memory | 2.1.15, 2.4      |
| Principle 3, "Safe by default"                                                                                  | The default is `read-write`, and the lock's setter takes no friction                                                                              | Ask what a context is at its first write; lowering protection is a confirmed, audited command; files only tighten                       | 2.1.2, 2.3       |
| Principle 5, "Lazy everything"                                                                                  | It forbids the fleet view the position needs                                                                                                      | Lazy by default; contexts the person pins may be watched in the background within a stated budget per identity                          | 2.2.3            |
| D2, macOS and Linux first, "only CI, signing and the test matrix" deferred for Windows                          | Three crates have no Windows port, Windows is the larger audience, and Linux is the unmeasured platform                                           | macOS first; Linux a preview until measured; Windows a milestone, with a compile check in CI now                                        | 2.1.16, 2.5.2    |
| D3 and D4, a third-party ecosystem on WASM components from the first API version                                | Over-built for one first-party provider; the component toolchain serves Rust authors well and others at a cost in size and tooling                | Tier 0 as data and a provider protocol as messages; WASM later, as a transport; no frames in the workbench                              | 2.4.7 to 2.4.9   |
| D5 and 6.6, "read + approved writes" for MCP, an optional HTTP endpoint, session scopes, a gateway              | Per-call approvals are accepted blindly, the session scope ends at the first untrusted read, and the gateway vouches for what the gate cannot see | Agents read and propose, the person applies; stdio only; no gateway                                                                     | 2.3              |
| D6, one space per cluster                                                                                       | Right for writes, too narrow for reads                                                                                                            | Reads may merge contexts; every write happens in the object's own space                                                                 | 2.2.3            |
| D7 and 3.3, Table watches for every list, projection watches for custom columns                                 | The projection watch re-lists a shared upstream for one person's column                                                                           | Sidecar columns joined in the query view                                                                                                | 2.4.14           |
| D10, the update endpoint at the repository's `latest.json`                                                      | It is compiled into every installed copy                                                                                                          | A domain the project controls, the repository second                                                                                    | 2.5.2            |
| D12, Kubernetes 1.33 and later                                                                                  | 1.33 and 1.34 are out of upstream support and 1.32 is still in paid support                                                                       | A tested floor, a warning below it, and 1.38 in the matrix                                                                              | 2.4.17           |
| 3.2, "one HTTP/2 connection per cluster" and "streaming lists on 1.34 and later"                                | A fixed 100-stream budget, a connection that three stalled streams can freeze, uncompressed lists, one exact fallback                             | Few counted connections; compression; a fallback on any refusal or silence                                                              | 2.4.10 to 2.4.13 |
| 3.8, webview memory without the GPU process                                                                     | The total is what a person sees in Activity Monitor                                                                                               | Report the total beside the budget                                                                                                      | 2.4.2            |
| 6.4, the order of mode sources                                                                                  | A person's choice and a kubeconfig's `readOnly: false` both lower a stricter mark silently                                                        | Lowering is explicit and logged; files only tighten                                                                                     | 2.1.2            |
| 6.4, a typed context name for "every other write, whatever it risks" in `guarded` (`docs/ARCHITECTURE.md:1994`) | A phrase typed for every scale becomes muscle memory; the evidence on prompts people accept points the same way                                   | Keep the typed name for wide and destructive writes, a plain confirmation for reversible ones (confidence: low to medium)               | 2.3.4            |
| 6.7, AppImage among the release formats                                                                         | It carries the build machine's WebKitGTK                                                                                                          | deb and rpm                                                                                                                             | 2.4.6            |
| `docs/decisions/code-quality.md:16`, "the same PR changes the document"                                         | It turned the architecture into a log and pull requests into 10,000-line squashes                                                                 | Keep it for invariants; features get a design note of their own                                                                         | 2.1.8, 2.1.17    |
| `docs/decisions/command-bus.md:16`, "the mock backend's bus mirrors each action"                                | It asks for a second implementation                                                                                                               | Shared case files or recorded traffic                                                                                                   | 2.1.12           |
| `docs/decisions/frontend-architecture.md:12`, the workbench "knows nothing of Kubernetes"                       | The code knows contexts, modes and sessions, rightly                                                                                              | Say what it may know                                                                                                                    | 2.1.9            |
| `.claude/rules/checks.md`                                                                                       | No `paths:`, and a 7,908-character item                                                                                                           | Split by crate; move the scenarios beside the mock                                                                                      | 2.1.10           |

### 2.2 Ahead of Lens, and of the category, for 2–3 years

**2.2.1 The gap Twigo was designed for has closed, and the category is flooded.**
Fact (read on 2026-11-14; counts are raw API data, and every quoted page was read again as raw text in the verification pass).

- Free and open clients are widely installed: Freelens 1.10.3 has 151,449 installer downloads since 2026-07-07 and Headlamp 0.45.0 has 61,775 since 2026-08-20 ([Freelens releases API](https://api.github.com/repos/freelensapp/freelens/releases), [Headlamp releases API](https://api.github.com/repos/kubernetes-sigs/headlamp/releases), accessed 2026-11-14).
  The Kubernetes Dashboard was archived on 2026-01-21 and points to Headlamp ([kubernetes-retired/dashboard](https://github.com/kubernetes-retired/dashboard)).
- GitHub lists 548 repositories created since 2025-01-01 that match "kubernetes desktop" ([search API](https://api.github.com/search/repositories?q=kubernetes+desktop+in:name,description,topics+created:%3E2025-01-01&sort=stars), accessed 2026-11-14).
  The category research read about forty desktop clients among the first results, and their releases draw tens to hundreds of downloads.
  One, created on 2026-10-11, describes itself as a "Free Kubernetes desktop client in Rust (Tauri 2), a Lens alternative with a built-in MCP server for AI agents" ([sextant](https://github.com/FriendsOfKubernetes/sextant)).
- The incumbents shipped Twigo's talking points this year, most of them in the three weeks before this review.
  Freelens 2.0.0: "Cluster requests travel over HTTP/2 end to end", and its request for workload logs closed on 2026-11-12 ([release notes](https://github.com/freelensapp/freelens/releases/tag/v2.0.0), 2026-10-28; [freelens#687](https://github.com/freelensapp/freelens/issues/687)).
  Aptakube 1.22.0: "Contexts can now be set to Protected or Read-only", with a temporary unlock ([releases](https://github.com/aptakube/aptakube/releases), 2026-10-27; the repository's own research cites the same release, `docs/research/workbench-chrome.md:19`).
  Lens: an MCP server since its 2026.3 release in March, which "introduces MCP server support" ([release notes](https://docs.lenshq.io/release-notes/lens-k8s-ide/lens-2026-3-130712/), page updated 2026-05-13), and on 2026-11-11 "Lens starts more than twice as fast" ([release notes](https://docs.lenshq.io/release-notes/lens-k8s-ide/lens-2026-11-91422/)).
- Radar is missing from the document's table of competitors: created 2026-01-20, Apache-2.0, 4,122 stars, "The missing open-source Kubernetes UI, with a built-in MCP server for your AI agent", with a timeline of changes; its hosted fleet view, Radar Cloud, is free for up to three clusters and costs from $149 per cluster a month above that ([skyhook-io/radar](https://github.com/skyhook-io/radar), [pricing](https://radarhq.io/pricing), accessed 2026-11-14).
- Users do not vote for speed: no performance complaint passes 19 👍 in the trackers of Lens, Freelens, k9s, Headlamp and Aptakube, against 755 for Lens's login wall ([lens#5444](https://github.com/lensapp/lens/issues/5444)), 199 for custom columns in k9s ([k9s#755](https://github.com/derailed/k9s/issues/755)), 147 for JSON logs ([k9s#364](https://github.com/derailed/k9s/issues/364)) and 146 for column widths in Lens ([lens#601](https://github.com/lensapp/lens/issues/601)).
- k9s is the largest engaged audience: 11,946 Homebrew installs in 30 days against about 4,000 for the casks of seven desktop clients together, Freelens 1,337, Headlamp 1,317, OpenLens 691, Lens 549, Aptakube 79, Monokle 13 and K8Studio 8 ([formula API](https://formulae.brew.sh/api/formula/k9s.json), [cask API](https://formulae.brew.sh/api/cask/freelens.json) for each, accessed 2026-11-14), its last release was 2026-06-06, and its maintainer writes "Sponsorships are dropping at an alarming rate which puts this project in the red" ([k9s v0.51.0](https://github.com/derailed/k9s/releases/tag/v0.51.0)).
- New clients written with AI meet open distrust: "My Pavlov reaction when I see the Claude icon next to the committer is: not touching this. Is trust in OSS now completely gone?" ([Hacker News](https://news.ycombinator.com/item?id=50009904), 2026-10-08).

So "an open Lens", "fast" and "has MCP" cannot be the position.
`docs/ARCHITECTURE.md:4` still states the first and `docs/ARCHITECTURE.md:32` the second, while `README.md:12` states another: what needs attention first.

**2.2.2 Which decisions give a durable advantage.**
Judgement (confidence: medium).
Anything a demo shows is now copied within a month; what cannot be copied quickly is correctness that needs real environments, a record of holding up, and an audience.

| Decision                                             | Verdict                                                                                                                                              | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Table watches with Rust-side sort, filter and window | Durable for two years against Freelens, unproven against Headlamp, copyable by the Rust newcomers within a year, invisible below about 5,000 objects | Freelens 2.0.0 still renders each cluster in an iframe of its own ([`cluster-frame-handler.ts` at v2.0.0](https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts)) and has pagination for cluster-wide pod lists open ([freelens#2117](https://github.com/freelensapp/freelens/issues/2117)); Headlamp 0.44.0 fetches pod lists a thousand at a time and claims "practical cluster support beyond 30,000 pods" (releases API above, 2026-07-29), six times past what Twigo has measured; the advantage is worth what the unrun 20k and 50k benches prove |
| One HTTP/2 connection with a stream budget           | Table stakes                                                                                                                                         | Freelens ships HTTP/2; the budget is hygiene nobody switches for, and today it is also a cliff (2.4.11)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| The policy gate below every actor                    | The surface is table stakes since October; the depth is an advantage for one to two years                                                            | Competitors confirm in a dialog; none has one enforcement point that child processes also meet. k9s's read-only mode let a CronJob trigger through ([k9s#4293](https://github.com/derailed/k9s/issues/4293), 2026-10-13). The depth is undercut by the default and by 2.1.2 to 2.1.5                                                                                                                                                                                                                                                                                                                                                 |
| The credential runner with a sign-in panel           | The most valuable first-minute advantage, durable about a year, since the incumbents have started on it                                              | Sign-in is a top class of Headlamp's most-voted issues ([headlamp#358](https://github.com/kubernetes-sigs/headlamp/issues/358), [#1716](https://github.com/kubernetes-sigs/headlamp/issues/1716)) and Lens's MFA request has been open since 2020 ([lens#208](https://github.com/lensapp/lens/issues/208), 72 👍), though Lens 2026.11 added a prompt for EKS roles that require a second factor (release notes above, 2026-11-11); the long tail of identity set-ups needs a test matrix and users, which clones lack                                                                                                               |
| Keyboard-first IDE workbench                         | The most durable felt difference against the GUI incumbents, and the entry ticket against k9s                                                        | Commands, context keys and keybindings are an architecture, not a feature                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Workload-level logs, the port-forward manager        | Reasons to stay, not to try                                                                                                                          | Both exist elsewhere now; the handling of rollouts and restarts is craft                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| An MCP server with approvals in the app              | Table stakes, and late                                                                                                                               | Lens ships it; free is the only edge, and Radar is free too (2.2.1, 2.3.2)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| WASM extensions                                      | The right substrate at the wrong time                                                                                                                | No user can load one at the beta (`docs/ARCHITECTURE.md:2174`); ecosystems follow users                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Vendor-neutral core                                  | Necessary hygiene                                                                                                                                    | Neutrality is judged from governance, and a sole maintainer who sells a Kubernetes platform starts behind a SIG project                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

Four assets are worth defending: the keyboard workbench, Rust-side windowed tables, the credential runner and the depth of the gate.
The second counts only once it is measured past the 30,000 pods Headlamp claims.
All four pay off most for one person: the operator who works across many clusters behind single sign-on.

**2.2.3 What is missing to still be ahead in 2028.**
Judgement (confidence: medium) unless marked.

- **Performance past the one measured point.**
  Nothing above 5,000 pods, on Linux or on an ordinary laptop is measured (2.1.15), and a fleet needs budgets that do not exist yet: memory per idle connected cluster, API requests per background cluster per minute, credential-plugin runs per hour.
- **Time to the first useful screen.**
  No budget and no number (2.1.15), while Lens now advertises its start-up time.
  A snapshot of the home shown at once with its age, and the login environment reused while it is resolved again, would make the first screen instant; both are cheap.
- **Many clusters.**
  Spaces hold one context (`docs/ARCHITECTURE.md:728`) and merged tables are "later" (`docs/ARCHITECTURE.md:2181`), while Aptakube, Headlamp and JET Pilot already merge clusters.
  What nobody ships in the open, with nothing installed in a cluster, is the problem-first view of a fleet: Radar offers it hosted, free up to three clusters, and "runs in each connected cluster" (pricing page above); Lens charges for multi-cluster comfort, k9s shows one context, Freelens cannot merge iframes.
- **What is wrong first.**
  Radar, sofka's incident view and Aptakube's Health page converged on the README's idea within a year.
  The step none has taken is to say what changed and who changed it at the moment the app opens, without having run beforehand: managedFields carry a manager and a time per entry, ReplicaSets and ControllerRevisions carry revisions, Helm keeps history.
  Twigo receives managedFields with every row and drops them (`docs/ARCHITECTURE.md:396-397`).
- **The incident's own action.**
  The MVP's actions have no rollback to an earlier revision (`docs/ARCHITECTURE.md:2169`); Helm rollback is "later" (`docs/ARCHITECTURE.md:2182`).
  Fact for the absence.
- **Edits that know who owns the field.**
  The diff could mark fields that Argo CD, Flux, Helm or an autoscaler owns and say the edit will be reverted; the managers are already kept for conflicts (`docs/ARCHITECTURE.md:500`).
- **Keyboard.**
  For a k9s user: their own aliases and hotkeys imported on day one, a which-key overlay, and a test that drives the core flows with no pointer.
- **Safety as a selling point.**
  The engineering is ahead of the category and the default is behind it: "Safe by default" (`docs/ARCHITECTURE.md:40`) with `read-write` for whatever nobody marked (`docs/ARCHITECTURE.md:1961`).
  Ask what a context is at the first write to an unmarked remote one.
- **Windows.**
  Windows is 24 to 31 % of the desktop downloads of Freelens 1.10.3 and Headlamp 0.45.0 and Linux 9 to 11 % of direct ones (release APIs above; APT and Flatpak installs are not visible).
  D2 ships the unmeasured platform before the larger one.

**2.2.4 Positioning: who the first 1,000 users are, and the wedge.**
Judgement (confidence: medium); the evidence for fleets is vendors' surveys, and requests for multi-cluster views are little voted ([k9s#1006](https://github.com/derailed/k9s/issues/1006), 7 👍).

- Who: platform, SRE and DevOps engineers in companies of 50 to 2,000 people, with 5 to 200 contexts on EKS, GKE and AKS behind single sign-on, on a Mac first; today they use k9s with kubectx and keep Freelens or OpenLens on the side.
  Operations roles are 49 % of Lens's own users and rising ([Lens user survey](https://www.mirantis.com/blog/lens-user-survey-2024-the-voice-of-our-community/), 2025-09-18, vendor); application developers "are increasingly accessing it indirectly through internal developer platforms" ([CNCF and SlashData](https://www.cncf.io/announcements/2026/03/24/cncf-and-slashdata-report-finds-cloud-native-community-reaches-nearly-20-million-developers/), 2026-03-24).
- Why they would switch from k9s: one context at a time, no view of what changed, and its most-wanted features are what a window does better (columns, JSON logs, several resource types at once).
- Why from Lens, Freelens or OpenLens: a window per cluster, pointer-driven work and sign-in trouble; Homebrew deprecated the OpenLens cask on 2026-11-06 while it still drew 691 installs in 30 days ([cask API](https://formulae.brew.sh/api/cask/openlens.json)).
- The wedge: triage for the operator of many clusters.
  One keyboard-driven screen says what is wrong, why, and what changed, and lets the person act under a guard; first in one cluster, then across every cluster in the kubeconfig without signing in forty times.
  It is the README's promise stretched over the fleet, it needs exactly the architecture Twigo has, and the open-source gap is structural.
- "Performance is the product" stays an engineering rule and leaves the pitch: it is the proof.
- Do not claim "lightweight": 654 MB at 5,000 pods will be found by the first person who opens Activity Monitor; claim latency, which the harness supports.

What "clearly better" looks like in sixty seconds: launch shows the attention view from the last snapshot with its age and turns live; `:deploy !ready @all` lists three rows across forty clusters; Enter says "degraded for 8 minutes, image v41 to v42 at 14:01 by the Argo CD controller, 3 of 5 pods crash, last line `missing env`"; `l` shows the workload's merged logs with the crashed run; Rollback shows the diff between revisions and asks for the context's name; the rows turn healthy.
No mouse, no account, nothing installed in any cluster.
No client does that today.

**2.2.5 What the NATS IDE teaches.**
Judgement (confidence: low to medium; I know of it only what the brief says).

- Good code is not a reason to install; one outcome in the first minute is.
- That product met a market with no habit of such a tool; this one meets a market with habits and forty lookalikes, so the danger moved from "nobody needs it" to "nobody notices it" and "nobody trusts it".
- Distribution is built before the release: partners with real fleets on nightly builds, a public bench, and write-ups that stand on their own.
- Decide the measure of success now, and a way to count it without telemetry (2.5).
- Show HN posts for desktop Kubernetes clients drew 3 to 6 points this year (2.5.3), while a clickable terminal client drew 69 ([Hacker News](https://news.ycombinator.com/item?id=50009904), 2026-10-08) and a focused log tool 126 ([Kubetail](https://news.ycombinator.com/item?id=43863418), 2025-05-01): lead with an engineering story, not a product launch.

### 2.3 The AI era

**2.3.1 The bet is right, and what is defensible is the position, not the gate's code.**
Judgement (confidence: high).

A stdio MCP server has no screen of its own, so the only place it can ask a person is the agent's client, which is the part that gets injected, auto-approved or run headless.
A desktop app that is already open holds three things no server can add: the credentials, the person's attention, and pixels the agent cannot draw.
The gate itself is about 2,200 lines and a test table (`crates/twigo-policy/src/`); a funded competitor copies that in a quarter.
So the claim to build is narrow and structural: through Twigo an agent gets a channel with no credential in reach and no write path.

**2.3.2 Twigo is not first, and the field around it is retreating from its own safety claims.**
Fact (verified on 2026-11-14; every page was read again as raw text in the verification pass).

- Lens ships an MCP server through its running desktop app, on paid plans: its kubectl tool is read-only and "Your AI tool prepares changes to your cluster in Lens editors and dialogs, and you decide whether to apply them" ([Lens MCP server docs](https://docs.lenshq.io/k8slens/mcp-server/), 2026-11-11; [pricing](https://www.lenshq.io/pricing/), accessed 2026-11-14).
  Its other tools go further: "Some Lens tools change Lens itself without asking, such as port forwards", and with the setting to let AI tools see and drive Lens on, the tool "also clicks and types in Lens" ([how it works](https://docs.lenshq.io/k8slens/mcp-server/how-it-works/), 2026-11-11).
  It is the architecture of 6.6, shipped, with a wider door than 6.6 plans, since a port-forward that starts unasked reaches workloads.
- The most used open server now writes "`read_only` and `denied_resources` are best-effort guardrails" and that Kubernetes RBAC "is the access control to rely on" ([containers/kubernetes-mcp-server README](https://github.com/containers/kubernetes-mcp-server/blob/main/README.md), accessed 2026-11-14).
- Azure's server "supports only stdio and must be launched as a local subprocess" after dropping HTTP and SSE ([Azure/aks-mcp README](https://github.com/Azure/aks-mcp/blob/main/README.md), accessed 2026-11-14).
- Flux159/mcp-server-kubernetes has six advisories in OSV for its npm package (queried through `https://api.osv.dev/v1/query` on 2026-11-14).
  In [CVE-2026-47250](https://osv.dev/vulnerability/CVE-2026-47250) (2026-06-11) a line planted in a pod's log makes the agent pass `--server` to kubectl, which then sends "the Authorization: Bearer \<token> header from the operator's kubeconfig to the attacker's endpoint".
  In [CVE-2026-46519](https://osv.dev/vulnerability/CVE-2026-46519) (2026-06-11) the restrictions were "enforced at the tool discovery layer (tools/list) but not at the execution layer (tools/call)".
- None of sixteen servers and assistants compared documents all of: approval in a separate trusted UI with a server-side dry-run diff, per-cluster modes, and a local audit of agent actions; "absent" here means absent from the README or docs page read.
- kagent reached 1.0 on 2026-11-09 with approval at its runtime and an identity per actor ([Solo.io](https://www.solo.io/blog/announcing-kagent-1-0-ga), 2026-11-10): the in-cluster guardrail market is being served, and Twigo's place is the workstation.

**2.3.3 Today's code does not yet support "agents can only do what you approved".**
Fact (verified), each line read in this review; the row on the planned scopes is a judgement.

| What the claim needs                                                                        | Today                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A non-human actor never writes, execs or forwards without a recorded decision of the person | False in `read-write`, the default (`crates/twigo-policy/src/actor.rs:52`, `crates/twigo-policy/src/policy.rs:262`); a test holds it for an agent's ConfigMap patch (`crates/twigo-policy/tests/gate.rs:917-918`), and only a write to a Secret is refused (`crates/twigo-policy/src/policy.rs:351-357`)                      |
| It reads only what a grant names                                                            | False: reads pass for every actor (`crates/twigo-policy/src/actor.rs:50`), and rows served from the hub's store send no request, so they never meet the gate                                                                                                                                                                  |
| It cannot reach workloads                                                                   | False: a port-forward and a plain GET through a pod's or a Service's `proxy` are the `Forward` class (`crates/twigo-policy/src/attributes.rs:299-300`), which passes in `guarded` and, by default, in `read-only` (`crates/twigo-policy/src/actor.rs:52-53`, `crates/twigo-policy/src/file.rs:44-59`)                         |
| Nothing the agent can reach lowers protection                                               | False: `twigo.readOnly: false` in a kubeconfig yields `read-write` ahead of the provider's mark and the Production default (`crates/twigo-kube/src/kubeconfig.rs:414-416`, `crates/twigo-policy/src/policy.rs:246-253`), and any process of the user can write that file                                                      |
| Only the broker mints an approval                                                           | A convention: `Approval::once` and `Approval::until` are public (`crates/twigo-policy/src/approval.rs:38`, `52`)                                                                                                                                                                                                              |
| A lasting approval cannot hand out power beyond Twigo                                       | False for a terminal, the one actor the broker offers it to today (`crates/twigo-core/src/approvals.rs:261-262`): "for 15 minutes" excepts only deletes (`crates/twigo-policy/src/approval.rs:81`), so it covers ServiceAccount tokens, RBAC bindings and exec; an agent's ask is answered once (`docs/ARCHITECTURE.md:1924`) |
| Every decision about it is recorded                                                         | False (2.1.4)                                                                                                                                                                                                                                                                                                                 |
| The planned scopes fit the planned rule                                                     | Barely: "this session" (`docs/ARCHITECTURE.md:2092-2093`) lasts only until the session reads untrusted content (`docs/ARCHITECTURE.md:2097`), and that is logs, events, annotations, ConfigMaps, CR status and Helm values (`docs/ARCHITECTURE.md:2096`), which almost every useful read carries                              |
| There is no way around Twigo                                                                | False and documented (`docs/ARCHITECTURE.md:1930-1943`); the claim has to say "through Twigo"                                                                                                                                                                                                                                 |

**2.3.4 Recommended design: agents read and propose, and only the person applies.**
Judgement (confidence: high on the direction, medium on the details).

- Give non-human callers one actor with an identity, `Principal { kind, name, session }`, named by Twigo and never by the client.
- The decision for a principal ignores how permissive the mode is: an MCP client and an extension never write, exec or forward in any mode; an agent's kubectl through the proxy asks per call in `guarded` and in `read-write`, and is refused in `read-only`; none of them reads a Secret's values.
- A grant names what a principal may read: the context by fingerprint, namespaces, and whether logs are included; the default is none; the mode caps it, as `docs/ARCHITECTURE.md:2076` already says.
  Check it twice, at the gate and at the tool, because cached rows skip the gate.
- A write an agent wants is a draft: a `propose_change` tool stores a manifest, Twigo shows it as a change with the server-side dry-run diff that 6.5 already builds, and the person's Apply is an ordinary bus plan, audited as proposed by the agent and applied by the person.
  That reuses M2 instead of adding a second approval system, and it makes the diff the unit of review.
- Approvals are minted only by the broker (a capability `Policy::new` hands the core once), and a lasting one never covers tokens, RBAC, CSRs, exec, ephemeral containers or impersonation.
- Kubeconfig metadata can only tighten; a lowering waits for the person's yes in the app, as a bus command with friction and an audit line (2.1.2).
- The audit records every decision about a principal, refusals included (2.1.4).
- Later, for contexts the person chooses, custody: the kubeconfig on disk holds no credential, its server is Twigo's proxy and its user an exec plugin that asks Twigo, so every kubectl on the machine, an agent's included, meets the gate.
  It is the SSH-agent pattern for Kubernetes and the only real closure of the documented bypass, at the price of Twigo standing in kubectl's path.

Why not per-call approved writes, as 6.6 plans.
Anthropic reports that people accept 93 % of permission prompts ([Claude Code auto mode](https://www.anthropic.com/research/claude-code-auto-mode), 2026-03-25), so many small asks protect little.
A vendor survey of over 1,000 respondents found that 75.7 % keep agents on read-only, approval-gated or non-critical work (Komodor, as reported by [Efficiently Connected](https://www.efficientlyconnected.com/komodor-2026-agentic-operations-governance-survey/) on 2026-11-09; the full report was not read).
The claim then reads: "Through Twigo an agent reads what you granted and changes nothing; every change is one you applied; every grant and refusal is in the log."
It is testable in the repository's own style, by what the server saw.
Effort M for the actor, the grants and the audit; the drafts are v1.x, but the bus contract must reserve a plan's origin and a proposal id before M3 freezes it (`docs/decisions/command-bus.md:12` binds a plan to the window that made it).

**2.3.5 No LLM client of its own: right, provided the hand-off takes one click.**
Judgement (confidence: high).

- Twigo gains: no keys, billing, model churn or data-processing terms, "no account, no telemetry" stays true, and no in-process model acts as the UI actor.
- The user loses an Explain button that answers in place.
- MCP sampling is not the middle path: revision 2026-07-28 deprecates Sampling, Roots and Logging and removes the handshake and the session ([MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog), 2026-07-28).
  `docs/ARCHITECTURE.md:2080` is right about the session and understates the rest.
- The cheap path, in order: Copy as prompt (a redacted, capped evidence bundle on the clipboard); Ask my agent (a terminal tab that runs the user's agent command with a prompt naming a bundle, always through the proxy as an agent, whatever the mode); three to five MCP prompts; `twigo://` links in every tool result that open the object in the app.

**2.3.6 The MCP server for the beta: ten read-only tools over the stdio shim.**
Judgement (confidence: medium).

- Transport: stdio only; drop the optional HTTP endpoint of `docs/ARCHITECTURE.md:2071` from the beta, for the reasons the other servers learnt (2.3.2).
- Protocol: 2026-07-28 through rmcp, which is the official Rust SDK, at 3.10.0 on 2026-11-12 ([crates.io](https://crates.io/crates/rmcp), accessed 2026-11-14); `tools/list` may not vary by connection in that revision, so enforcement belongs at the call.
- Tools: `contexts`, `list` (Table rows), `get` (redacted), `describe` (the Overview as text and as structured data), `events`, `logs` (only with the grant's logs flag), `diff` (server-side dry run, only for groups kube-apiserver serves itself), `schema`, `access`, `open_in_twigo`.
- No exec, attach, port-forward, generic kubectl or Secret values, and no kubectl process underneath, so the flag and command injection of those advisories has nothing to act on.
- Every result begins with the context, its type, its mode and the cluster's fingerprint, since the wrong cluster is the classic agent mistake; lists stay Table rows, which is also the largest token saving against servers that return whole objects.
- Redaction is one function and one type for Secrets and Helm values, with a canary test across every tool, and by pattern for the rest.
- The grant is asked in Twigo's window, never through elicitation, which the client would draw.

**2.3.7 AI-native workflows: where each belongs.**
Judgement (confidence: medium).

| Workflow                         | Who needs it                      | Where                                                                        | Hook to fix before the contracts freeze                                           |
| -------------------------------- | --------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Explain a failure                | Every on-call engineer            | Core supplies the evidence bundle; the user's agent explains                 | A versioned bundle schema: the Overview as structured data, shared by IPC and MCP |
| What changed                     | The same                          | Core: diff against the previous ReplicaSet, Helm revision or last applied    | A `changes` part in the bundle                                                    |
| Review a change before apply     | Anyone whose agent writes YAML    | Core: draft change sets                                                      | A plan's origin and a proposal id in the bus contract                             |
| What-if before a drain or delete | Agent and person                  | Core: `command_plan` exposed read-only                                       | None; plans already list what goes                                                |
| Incident timeline                | Incident leads                    | Core view, later                                                             | None now                                                                          |
| Runbooks run by agents           | Platform teams                    | Nowhere as unattended runs; a runbook step is a draft the person applies     | Covered by drafts                                                                 |
| Natural language in quick access | Newcomers                         | Nowhere with a model inside Twigo; the user's agent drives addressable views | A URI for every list, filter and object                                           |
| Agent activity report            | Teams that must justify agent use | Core panel over the audit                                                    | The audit's event schema                                                          |

**2.3.8 Do not build the ACP panel or the MCP gateway now.**
Judgement (confidence: medium for the panel, high for the gateway).

- ACP is real, with 51 agents listed ([agents](https://agentclientprotocol.com/get-started/agents), accessed 2026-11-14), but its version 2 is a breaking draft with no date ([announcement](https://agentclientprotocol.com/announcements/acp-v2-draft), 2026-07-20), and a panel means rendering chat, tool calls and permission requests for all of them on three systems.
  The agent in a terminal tab gives most of it for days of work, and hosting an agent blurs the line the safety claim rests on: who is the person.
- The gateway (`docs/ARCHITECTURE.md:2109-2118`) would make Twigo vouch for third parties' tool descriptions and hold their tokens, while the document itself says the policy layer "cannot see what such a server does".
  Take `mcpServers` out of the manifest's vocabulary (`docs/ARCHITECTURE.md:1627`, `1644`) before the schema is published; an extension can list suggested servers as data, and "Connect an agent" can write them into the client's own configuration.

**2.3.9 Real demand, and hype.**
Judgement (confidence: medium).

- Real: an engineer who already runs a coding agent wants it to see the cluster without pasting kubectl output and without handing it the keys; guardrails, which buyers name as their top problem in the survey above; review of machine-written changes before they land.
- Hype for a desktop tool: unattended remediation, a built-in assistant as a differentiator, agent crews and marketplaces, detectors of injected text.
- The first helps adoption directly, and the second is where Segla could differ from other platforms later: a provider that ships an `agents` cap in the policy file gives its customers a governed default.

**2.3.10 Clusters for AI workloads: a growing niche the incumbents have entered, so parity and one join, not a wedge.**
Fact for the evidence (2026-11-14); the selection: Judgement (confidence: medium).

- The demand is real and a minority: "66% of organizations hosting generative AI models use Kubernetes to manage some or all of their inference workloads", while "44% report they do not yet run AI/ML workloads on Kubernetes" ([CNCF annual survey](https://www.cncf.io/announcements/2026/01/20/kubernetes-established-as-the-de-facto-operating-system-for-ai-as-production-use-hits-82-in-2025-cncf-annual-cloud-native-survey/), 2026-01-20).
- The APIs are stable enough to build on: DRA's core is GA and its kinds are at `resource.k8s.io/v1` ([DRA docs](https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/), accessed 2026-11-14); native gang scheduling (Workload and PodGroup) reached beta in 1.37 ([Kubernetes blog](https://kubernetes.io/blog/2026/09/08/kubernetes-v1-37-advancing-workload-aware-scheduling/), 2026-09-08).
- Upstream names the gap itself: "When pods fail to schedule due to insufficient resources, users cannot easily see what is available vs. what is consumed" ([KEP-5677](https://www.kubernetes.dev/resources/keps/5677/), accessed 2026-11-14).
- The incumbents are already there: Lens lists ResourceClaims, ResourceSlices and DeviceClasses and shows each of a node's devices with "the ResourceClaim holding it" ([Lens docs](https://docs.lenshq.io/k8slens/how-to/use-dra/), 2026-09-03), and Headlamp has an alpha Kueue plugin with "read-only views for Kueue v1beta2 Cohorts, ClusterQueues, LocalQueues, ResourceFlavors, and Workloads" ([Kubernetes blog](https://kubernetes.io/blog/2026/10/14/tracing-kueue-admission-with-headlamp/), 2026-10-14) beside its Kubeflow plugin ([Kubernetes blog](https://kubernetes.io/blog/2026/07/13/introducing-headlamp-plugin-for-kubeflow/), 2026-07-13); no k9s view of either was found, which does not prove absence.
- Who needs it: the few people in a company who run a shared GPU cluster and are asked daily why a job does not start and who holds the GPUs.

The smallest set worth building, on the sidecar columns of 2.4.14.

1. Nodes: GPU capacity, allocatable and allocated as columns and in the node's Overview, from extended resources and ResourceSlices; core.
2. Devices: a per-pool view that joins ResourceSlices with ResourceClaims into available against consumed, and from a pod to its claims and devices; core, and parity with what Lens shows per node.
3. Pending work: for a pod or a workload that does not start, the reason from the scheduler, the claim, the queue or the pod group in one place, as a Diagnostics finding; core, modelled on PodGroup as well as on Kueue's Workload, and the one part I found on neither incumbent's page.
4. Queues: Kueue's ClusterQueue and LocalQueue usage against quota and pending workloads; a first-party extension, since Kueue is still 0.x with weekly releases ([Kueue releases](https://github.com/kubernetes-sigs/kueue/releases), accessed 2026-11-14), a real consumer for the extension API, and parity with Headlamp's alpha plugin.

Model-serving dashboards, pipelines, notebooks and token metrics are hype for a general IDE and belong to the Kubeflow-style plugins that already exist.
JobSet, LeaderWorkerSet, Ray and TrainJob need nothing special: their CRDs print columns and the owner graph already relates their pods.
Horizon: v1.x; it keeps users in that niche and does not win them, and it helps Segla only if Segla sells GPU capacity.

### 2.4 The big technical bets

#### Bet 1: Tauri and the system webviews

**2.4.1 The largest bet is the only one the document never records.**
Fact (verified).
D1 to D12 hold no decision about the UI platform (`docs/ARCHITECTURE.md:15-28`); Tauri arrives through the reuse map from the legacy repository (`docs/ARCHITECTURE.md:93`), and the file weighs no alternative.
It is three bets with different odds: that a DOM and React interface is fast enough for a keyboard-first, data-dense IDE; that each system's own web engine is an acceptable host for it; and that Tauri stays maintained as shell, IPC, bundler and updater.

**2.4.2 On macOS the budgets measure the Rust core far more than the renderer, except for memory and, perhaps, frame rate.**
Fact for the numbers; the reading of them: Judgement (confidence: high).

| Dimension                   | Measured on macOS                                                  | The webview's part                                                                                                                                                                               | Reading                                                                    |
| --------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Change to painted cell, p95 | 66.4 ms (`docs/bench.md:136`)                                      | about 12 ms on the mock (`docs/bench.md:258`)                                                                                                                                                    | The 50 ms flush window dominates                                           |
| First paint                 | 292 ms (`docs/bench.md:135`)                                       | about 19 ms on the mock (`docs/bench.md:256`)                                                                                                                                                    | Not the renderer                                                           |
| IPC                         | 0.17 to 0.30 ms an invoke (`docs/spikes/tauri-isolation.md:66-71`) | —                                                                                                                                                                                                | Not a limit                                                                |
| Memory                      | 146 + 245 + 263 = 654 MB (`docs/bench.md:139-142`)                 | 508 MB, 78 %                                                                                                                                                                                     | The renderer is the cost                                                   |
| Scroll                      | 60.0 fps, "display frame 17.0 ms" (`docs/bench.md:137`)            | The driver takes the display's frame from `requestAnimationFrame` itself (`apps/desktop/bench/driver.ts:246-252`) and the report judges against a fixed 60 (`bench/harness/src/report.rs:17-19`) | It cannot tell a 60 Hz display from a webview capped at 60 on a 120 Hz one |

- Tauri closed a report of WKWebView capping `requestAnimationFrame` at 60 fps as something it cannot change ([tauri#13978](https://github.com/tauri-apps/tauri/issues/13978), closed 2025-08-11: "As far as we know there's nothing we can do about this.").
  Whether current macOS lifts the cap is disputed ([WebKit bug 294338](https://bugs.webkit.org/show_bug.cgi?id=294338), 2025-08-18).
  Which display the bench runs used is not recorded: not verified.
- Any page that repaints holds about 260 MB in WebKit's GPU process: a blank page that updates one number measured 59 MB and 256 MB (`docs/bench.md:288`, `297-301`), so a window with anything live in it costs about 315 MB of WebKit before the list's own memory.
  The budget passes because that process was taken out of it (`docs/ARCHITECTURE.md:661-662`).
- Cold start, key press to paint in a list, typing latency in quick access and the editor, and terminal echo have no row in the report (`docs/bench.md:67-76`).
  For a keyboard-first tool those are the performance a person feels.

**2.4.3 On Linux the bet is unmeasured, and the public evidence is bimodal: fine, or broken.**
Fact for the evidence (read on 2026-11-14); the forecast: Bet (confidence: medium-low).

- Nothing was measured on WebKitGTK and the sampler's Linux branch is not written (`docs/bench.md:102`, `346-347`).
- Tauri's maintainers wrote of "webkitgtk getting worse/more unstable each release" and started a Chromium runtime because of it ([tauri discussion 8524](https://github.com/orgs/tauri-apps/discussions/8524), 2024-01-02 and 2025-03-03).
- Tauri's own guide says most Linux graphics failures "come from the WebKitGTK DMABUF renderer requesting buffer formats the NVIDIA driver does not provide" ([Linux graphics](https://v2.tauri.app/develop/debug/linux-graphics/), 2026-06-15).
- The installed base spans three engine series: 2.50 on Ubuntu 22.04, 2.52 on 24.04 and 26.04, 2.54 on Fedora and Arch ([Launchpad](https://launchpad.net/ubuntu/+source/webkit2gtk), [Fedora](https://packages.fedoraproject.org/pkgs/webkitgtk/webkit2gtk4.1/), [Arch](https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/), accessed 2026-11-14), and 2.54 replaced the compositor ([WebKitGTK 2.54](https://webkitgtk.org/2026/09/16/webkitgtk-2.54-highlights.html), 2026-09-16).
- An AppImage carries the build machine's WebKitGTK: one report measured 5.8 fps with the bundled engine against 60.1 fps with the host's on the same computer ([happier#584](https://github.com/happier-dev/happier/issues/584), 2026-10-16; one report).
- One app moved from Tauri to Electron over Linux rendering in the last six months ([Paseo](https://paseo.sh/blog/i-was-wrong-about-electron), 2026-05-28), and another opened an issue to decide on the same move over the differences between WKWebView and WebView2 ([Quill#327](https://github.com/yicheng47/quill/issues/327), 2026-11-10, open).
- The way out now exists inside Tauri: 3.0 is in alpha with an official bundled-Chromium runtime, `tauri-runtime-cef` ([Tauri 3 CEF](https://v3.tauri.app/develop/cef/), 2026-09-13; [crates.io](https://crates.io/crates/tauri-runtime-cef), accessed 2026-11-14), at the price of a package "hundreds of megabytes larger than with wry".

The risk to a product sold on speed is not a slower mean; it is a blank window on a common GPU on launch day.

**2.4.4 The alternatives, honestly.**
Judgement (confidence: medium).

| Option                          | For                                                                                                                                                                                                                                                | Against                                                                                                                                                                                                                                                                                                                                                                    | Fit in November 2026                                            |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| System webview (Tauri 2)        | Every judged row but Core RSS, a Rust-side number, passes on macOS (2.1.15); the Tauri glue is about 1,170 lines (`apps/desktop/src-tauri`); the webview talks to Rust through one two-method interface (`packages/protocol/src/backend.ts:17-27`) | Linux above; the 60 fps question; the WebKit workarounds already paid for (`docs/ARCHITECTURE.md:1004-1007`, `1067`, `1508-1515`)                                                                                                                                                                                                                                          | Right for macOS now and for Windows on paper; unproven on Linux |
| Bundled Chromium under Tauri 3  | One engine on Linux and Windows; the same shell and IPC                                                                                                                                                                                            | Alpha; package size; an open idle-CPU bug on Linux ([tauri#16189](https://github.com/tauri-apps/tauri/issues/16189), 2026-10-01)                                                                                                                                                                                                                                           | The named fallback for Linux                                    |
| Electron                        | Monaco and xterm.js are built against it                                                                                                                                                                                                           | Installers about ten times larger (a Tauri client measured 17.1 MiB against Freelens's 190.2 MiB, [srelens](https://github.com/srelens/srelens/blob/2194e83ec53e/docs/PERFORMANCE.md), 2026-08-16); a Node main process; the same DOM cost                                                                                                                                 | Only if Tauri 3 stalls                                          |
| GPUI                            | No web engine, so none of the 508 MB, no frame cap, no script engine that renders cluster text; Zed 1.0 runs on three systems ([Zed 1.0](https://zed.dev/blog/zed-1-0), 2026-04-29)                                                                | The crate is 0.2.2 from 2025-10-22 with a release request closed ([zed#66275](https://github.com/zed-industries/zed/issues/66275), 2026-10-30); accessibility does not yet reach a focused text field ([zed#66691](https://github.com/zed-industries/zed/issues/66691), 2026-11-08); Zed's editor is GPL, so a YAML editor with schema completion would have to be written | The only native candidate; not before the beta                  |
| Slint, egui, Iced, Xilem, Freya | Slint is at 1.18 ([crates.io](https://crates.io/crates/slint), accessed 2026-11-14)                                                                                                                                                                | The other four are at 0.x (the same API); no Monaco-class editor and no terminal widget were found for any of them (search summaries only: not verified)                                                                                                                                                                                                                   | None                                                            |

What a native renderer would buy is memory, a higher frame ceiling and a smaller attack surface.
It would not change change-to-paint, first paint or idle CPU by an amount a person can see, because sort, filter and windowing already live in Rust (`docs/ARCHITECTURE.md:432-468`).

**2.4.5 The cost of reversing, and what keeps the option open.**
Judgement (confidence: low to medium on the weeks).

- Engine on Linux, wry to bundled Chromium: two to three weeks at any date, and cheaper once Tauri 3 is stable.
- Renderer, DOM to native: three to five months now, and more with every UI feature; about 33,000 lines of UI code (the `ui`, `workbench` and `kube` packages outside test files) and Monaco, xterm.js, dockview and the design system would go.
- One decision would make the renderer swap impossible: tier-2 extension frames inside the workbench (2.4.9).
- The IPC contract is renderer-neutral except in three places: the YAML dialect that decides what is sent to a cluster lives in TypeScript (`crates/twigo-ipc/src/apply.rs:38-48`), the schema command is shaped for monaco-yaml (`crates/twigo-ipc/src/command.rs:283-285`), and commands, `when` expressions, context keys and the keybinding resolver live in TypeScript (`packages/workbench/src/commands`, `contextkey`, `keybindings`) just as they are about to become public contracts for `keybindings.json` and extension manifests.
- The YAML editor is the longest pole of any renderer change and the weakest dependency chain, monaco-yaml on a worker manager last released in 2022 and patched around twice (`docs/ARCHITECTURE.md:1314-1315`).
  A Kubernetes YAML language service in Rust (parsing with positions, validation against the cluster's schema, completion and hover over IPC) would make the editor replaceable and give MCP a validator for manifests; it is a month or two of work and belongs after the beta.

**2.4.6 What to do before the beta.**
Judgement (confidence: high).

1. Run the bench's `refresh()` on a 120 Hz panel; it takes minutes and says whether the macOS build draws at half the panel's rate.
2. Open the mock page in a WebKitGTK shell on a Linux laptop and run the driver's scroll; hours.
3. Run the harness on real Linux desktops, Mesa and NVIDIA, Wayland and X11, WebKitGTK 2.50, 2.52 and 2.54; two to four days with the sampler's Linux branch.
4. Add the rows that are missing: launch to first rows, key to paint, total memory with the GPU process.
5. Record the UI platform as a decision with its falsifiers: macOS on wry; Linux on WebKitGTK if step 3 passes, on bundled Chromium if it does not, and otherwise labelled a preview.
6. Ship deb and rpm, which use the system's engine, and no AppImage until it can carry a current one.
7. Declare WebKitGTK 2.50 the floor, put the engine's version into the diagnostics, and ship a GPU detection shim with a `--safe-rendering` flag, as a large Tauri app now does ([block/buzz#3271](https://github.com/block/buzz/pull/3271), merged 2026-07-28).
8. Freeze `when` expressions and keybinding resolution with shared case files run by Rust and TypeScript, as the query and log cases already are, and adopt one rule: logic that an MCP client, a second window or a second renderer would need lives in Rust.
9. Do not start a native rewrite; spike the pod list on GPUI against `twigo-core` once, after the beta, so the 2028 decision has a number.

#### Bet 2: the extension runtime

**2.4.7 Four tiers, wasmtime, WIT, grants and signing are over-built for a beta whose one extension is first-party.**
Fact for the state; the judgement: confidence medium-high.

- Nothing of it exists: the host and API crates are one line each and no manifest depends on wasmtime.
- For one provider written by the maintainer, D3 and D4 commit M3 to a wasmtime host, a WIT package with version directories, a guest SDK, a manifest schema, grants with a UI, host HTTP with an allowlist, an OAuth host, a secrets store, declarative forms, publisher keys and a fixture extension (`docs/ARCHITECTURE.md:1531-1604`, `2174`).
- The sketched WIT is half untyped already: `execute-command`, `provide-rows` and `submit-form` take and return JSON in strings (`docs/ARCHITECTURE.md:1595-1599`).
  The typed interface, the component model's main gift, would describe only clusters, credentials and HTTP.
- The first provider needs no local code: its sign-in is OAuth run by the host, its list is one HTTPS call, its credential is a token exchange (`docs/ARCHITECTURE.md:1692-1698`), and its vendor already ships an exec credential plugin (`docs/ARCHITECTURE.md:1680`).
- Kubernetes' own design for cluster inventories gets credentials the same way: it will "reuse the exec approach and protocol used for external credentials in Kubeconfig" ([KEP-4322](https://www.kubernetes.dev/resources/keps/4322/), alpha, accessed 2026-11-14).

**2.4.8 The component model in 2027: mature as a mechanism for Rust guests, still costly as the public API for people who write Go and TypeScript.**
Fact for the evidence (2026-11-14); the conclusion: Judgement (confidence: medium).

- WASI 0.3.0 shipped on 2026-06-11 ([Bytecode Alliance](https://bytecodealliance.org/articles/WASI-0.3)), and wasmtime enables it; `docs/ARCHITECTURE.md:1556` ("WASI 0.3 async is new") is outdated in the good direction.
- Wasmtime releases a major each month that "reserves the right to break both behavior and API backwards-compatibility", with every twelfth supported for 24 months ([stability](https://docs.wasmtime.dev/stability-release.html), accessed 2026-11-14).
- A JavaScript component is about 13 MB, a user's figure, and shrinking it has "never been high enough on our list of priorities" ([ComponentizeJS#291](https://github.com/bytecodealliance/ComponentizeJS/issues/291), 2025-09-08, still open).
  wasmCloud lists the Go and TypeScript toolchains as well supported, yet "the standard Go compiler has no `wasip2` target yet" and reaches a component through "newer, pre-1.0 tooling", while TinyGo, a subset of Go, targets it directly ([wasmCloud docs](https://wasmcloud.com/docs/wash/developer-guide/language-support/), 2026-08-19).
- Zed, the model D4 cites, is still Rust-only for extension logic ([Zed docs](https://zed.dev/docs/extensions/developing-extensions), accessed 2026-11-14) and keeps about ten API versions side by side ([wit at v1.27.0](https://github.com/zed-industries/zed/tree/v1.27.0/crates/extension_api/wit)).
- Its sandbox was escaped through the installer, not through WASM ([CVE-2026-27976](https://osv.dev/vulnerability/CVE-2026-27976), 2026-02-25).
- Helm 4 chose one versioned plugin API with two runtimes, a subprocess and WASM, and kept its old plugins working ([Helm plugins](https://helm.sh/docs/plugins/overview), accessed 2026-11-14).
- The history D3 wants to avoid continued this autumn: Lens rebuilt extensions as a premium feature ([Lens 2026.10](https://docs.lenshq.io/release-notes/lens-k8s-ide/lens-2026-10-51501/), 2026-10-08) and Freelens 2.0 broke every v1 extension ([release notes](https://github.com/freelensapp/freelens/releases), 2026-10-28).
  Both broke because the API was the host's internals, which the document already rules out (`docs/ARCHITECTURE.md:1567`).

**2.4.9 The smallest version that keeps the security promises.**
Judgement (confidence: medium-high).

The promises are three: credentials never reach the webview, nothing foreign executes in the workbench, capabilities are declared and enforced.
All three are about Rust owning the calls; none needs WASM.

1. Tier 0 as planned: a manifest checked against a published schema, with only the contribution points a real extension uses.
2. A provider protocol, version 0, as JSON messages with a published schema: list clusters, resolve a credential, create a cluster with progress.
   Take its vocabulary from Kubernetes where one exists: the `ExecCredential` answer and the cluster-inventory design's access providers.
3. Two transports that run nothing foreign in the process: a remote HTTPS endpoint, where Rust makes every request to the hosts the manifest declares, runs the OAuth flow and keeps tokens in the keychain; and an exec transport that speaks the same messages over stdio, behind the plugin trust review that already exists (`crates/twigo-core/src/trust.rs`).
4. Enforcement from the first day: the host allowlist with redirects re-checked, and a provider scoped to the contexts it provides.
5. No wasmtime, no WIT, no guest SDK and no package signing in the beta; a WASM transport can join later as a third way to carry the same messages.
6. One rule for a future registry: it never distributes native code.
7. Drop tier 2, frames inside the workbench, from the roadmap: it rests on one implementation detail of Tauri, the invoke key (`docs/spikes/tauri-isolation.md:155-173`), was never probed on WebView2, and would make a web engine a permanent part of the public API.
8. Build the JSONPath evaluator that tier 0 needs for custom columns and resource sections (`docs/ARCHITECTURE.md:413-416`, `1649`): unlike the WASM host it serves every user of every CRD on the first day.

The cheapest falsifying experiment: build the first provider twice on the existing credential runner, once against a remote endpoint and once against the vendor's CLI.
If sign-in, list, credential and create work in a few days with no code in the process, D4 is not needed for the beta, and M3 loses its largest unbuilt part.
Cost of reversing: nothing while the API is private at `0.x`; after a public 1.0 defined as WIT, leaving it breaks every extension, while a 1.0 defined as messages can gain or retire a transport behind a deprecation window.

#### Bet 3: one HTTP/2 connection per cluster, Table watches, Rust-side query views

The design is right in outline: the server prints the columns kubectl prints for every kind at a fraction of an object's memory, and Rust owns sort, filter and window.
Every number behind it, though, comes from 5,000 small kwok pods on loopback (`docs/bench.md:113`, `343-348`).
Reading the code against real clusters gives three walls and one trap.

**2.4.10 Wall one, bytes on the wire to a remote cluster: no list or watch of the hub asks for compression.**
Fact (verified); the arithmetic below is computed, not measured.

- The hub's requests set only `Accept` (`crates/twigo-cache/src/request.rs:84-135`); the one `Accept-Encoding` in the workspace is the metrics poller's (`crates/twigo-cache/src/metrics/fetch.rs:57`), and the client stack has no decompression layer (`crates/twigo-kube/src/client.rs:130-141`).
- A Table row with metadata is about 2 KB of JSON: 9.9 MiB for 5,000 pods (`docs/spikes/table-decoder.md:91`), most of it managedFields (`docs/bench.md:186`).
- So 5,000 pods take about 4 s at 20 Mbit/s against a 1 s budget, and 50,000 pods (99 MiB) about 42 s; on a link with 1 % loss and 80 ms round trip one TCP connection carries about 1.8 Mbit/s for every stream of the cluster.
- kube-apiserver compresses get and list responses for a client that asks ([API concepts](https://kubernetes.io/docs/reference/using-api/api-concepts/), accessed 2026-11-14), and Go clients ask by default.
  Streaming lists were uncompressed until 1.37, where `WatchListCompression` is beta and on ([`kube_features.go` at v1.37.2](https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/features/kube_features.go)).
- Upstream measured the gap at about 165,000 pods: "WatchList sends 1,572 MB on the wire. LIST sends 232 MB for the same pods" ([kubernetes#138670](https://github.com/kubernetes/kubernetes/issues/138670), opened 2026-04-29, in the author's first comment).
- So "streaming lists on 1.34 and later" (`docs/ARCHITECTURE.md:361`) is not uniformly the faster path: on 1.34 to 1.36 over a slow link a paged list with gzip beats it.

Recommendation: send `Accept-Encoding: gzip` on paged lists on every release and on streaming lists where the server answers with it; choose paged or streaming by the throughput of the first responses; leave a fast link uncompressed.
kube-rs opts watch streams out of gzip ([kube 5.0.0 notes](https://github.com/kube-rs/kube/releases/tag/5.0.0), #2080), so this lives in Twigo's request path.
Effort S to M, before the beta, because it moves the headline number for every real cluster.

**2.4.11 Wall two: one connection with a fixed budget of 100 streams.**
Fact (verified) for the code; the scenarios: Judgement (confidence: medium-high).

- The budgets are constants that add up to 100 (`crates/twigo-kube/src/client/counter.rs:72-83`), on the assumption of kube-apiserver's default.
  OpenShift ships 2,000 streams per connection ([operator default config](https://github.com/openshift/cluster-kube-apiserver-operator/blob/268765be7155a9ab08b1d5b8976cdb371b0385c6/bindata/assets/config/defaultconfig.yaml)), and Go clients never meet the limit, since Go's transport dials another connection when one is full ([x/net http2 transport at v0.38.0](https://github.com/golang/net/blob/v0.38.0/http2/transport.go)).
- A person without cluster-wide list rights gets one watch per namespace and kind (`crates/twigo-cache/src/hub.rs:318-334`).
  A view shows the least ready of its parts (`crates/twigo-cache/src/hub.rs:1183-1209`) and sends rows only when ready, relisting or stale (`crates/twigo-cache/src/view.rs:854-859`).
  With the indexes taking three of the 24 watches, a selection of about 22 namespaces leaves one part `queued`, and the list then shows no rows at all for as long as the selection stands.
  That is the ordinary shape of access in a company: a developer with a few dozen namespaces and no cluster role.
- Above four namespaces a person who may list cluster-wide downloads the whole cluster, whatever the sizes (`crates/twigo-cache/src/hub.rs:50`, `318-319`): five small namespaces of a 500,000-pod cluster fetch every pod.
- Rare but total: three stalled streams can freeze the cluster's connection.
  hyper's windows are 2 MB a stream and 5 MB a connection ([`client.rs` at v1.12.0](https://github.com/hyperium/hyper/blob/v1.12.0/src/proto/h2/client.rs)), and capacity returns only as a body is polled ([`incoming.rs` at v1.12.0](https://github.com/hyperium/hyper/blob/v1.12.0/src/body/incoming.rs)); Twigo sets none (`crates/twigo-kube/src/client.rs:175-188`).
  The spike names the hazard, "one unread stream cannot stall the others, but three could", and answers it for the hub, which reads every stream at once (`docs/spikes/http2.md:176-179`).
  The policy proxy, built later, hands the server's body to the child frame by frame (`crates/twigo-core/src/proxy/forward.rs:136-166`), so a child that stops reading, a `kubectl logs -f` behind a pager or a job stopped with Ctrl-Z, stops the proxy from polling its stream.
  Three such streams hold the connection's window, and every watch and request of that cluster, the UI's included, stalls.
  Pings still pass, and the idle probe's timeout covers response headers only (`docs/ARCHITECTURE.md:316-318`), which are not flow-controlled, so nothing retires the connection.
  Not run; read from the code and hyper's source.

Recommendation, in order.
Give the policy proxy's streams a connection of their own, or size the windows so that streams times the stream window fits the connection's, and put a total timeout on the probe (S).
Show the rows of the parts that are ready when another part is queued or forbidden (S, but it touches a view state, so before the contracts freeze).
Read the server's `SETTINGS_MAX_CONCURRENT_STREAMS`, scale the budgets to it, and dial a second connection when a class is full, as Go does; "one connection per cluster" should become "few, counted connections" (M).
Count before listing, with `limit=1` and `remainingItemCount`, to choose between one cluster-wide upstream and one per namespace by cost, and to give `syncing` a total (M).

**2.4.12 Wall three: everything past the one measured point.**
Judgement (confidence: medium); computed from struct layouts, nothing measured.

- About 0.83 KB a row (700 and 130 bytes, `docs/ARCHITECTURE.md:429-430`) is the store alone; a query view adds about as much again, and the uid is held as text in several places per row (`crates/twigo-cache/src/store.rs:31-53`, `crates/twigo-cache/src/view.rs:662-746`).
- A realistic pod with ten labels comes to about 2.2 KB a row with one view: roughly 110 MB at 50,000 pods, 440 MB at 200,000 and 1.1 GB at 500,000.
- A relist holds the store twice until it ends (`crates/twigo-cache/src/upstream.rs:613-633`), and a sort change holds two views (`TODO.md:31`).
- A workload's logs or forward follow every pod of the namespace as whole objects (`crates/twigo-sessions/src/pods.rs:99-104`).
- The planned merged table across contexts (`docs/ARCHITECTURE.md:464-465`) would copy an entry, an id and a key per row into one index: 200 contexts of 5,000 pods are a million rows, about 2 GB as built.

Recommendation: run the harness at 20,000, 50,000 and 200,000 pods with realistic labels and annotations and one WAN profile before the beta, since every scale claim rests on arithmetic.
Compact rows (interned strings, a 16-byte uid, a 32-bit handle per row that views hold) are worth doing before merged tables, not before the beta.
Merged views should be a k-way merge over per-context indexes, never one merged index.

**2.4.13 The trap: lists that never load where kubectl works.**
Fact (verified) for the code; the reach: Judgement (confidence: medium).

- Whether streaming lists work is learnt once per cluster, yet aggregated API servers are other servers behind the same URL.
- The fallback to pages fires on one exact answer, a 422 whose cause names `sendInitialEvents` (`crates/twigo-cache/src/upstream.rs:709-717`).
- A streaming list ends only on a bookmark annotated `k8s.io/initial-events-end` (`crates/twigo-cache/src/upstream.rs:587-595`); a server that accepts the request and never sends it leaves the view in `syncing` for good.
- Such servers existed in 2026: an aggregated server accepted the request with a 200 and "never emits the terminal `initial-events-end` BOOKMARK" until a fix ([kubescape/storage#330](https://github.com/kubescape/storage/pull/330), merged 2026-06-18); an upstream issue about fake clients carries reports against real servers in its comments ([kubernetes#135895](https://github.com/kubernetes/kubernetes/issues/135895), open); and a fleet tool's controller "fails to receive the required bookmark event marking the end of the initial list stream" ([rancher/fleet#5059](https://github.com/rancher/fleet/issues/5059), reopened 2026-11-04).
- kubectl lists and then watches, so it works against all of them.

Recommendation: keep the fact per API group, fall back to pages on any 4xx to the streaming request and when a streaming list ends or idles without its end bookmark, and remember the answer.
Effort S, before the beta.

**2.4.14 Table watches as the only list path: the right default, the wrong monopoly.**
Judgement (confidence: high).

- What a person loses next to a client that holds objects: columns the server does not print, sorting by any field, joins across kinds (pod to node to device, workload to queue), and search inside objects.
- The planned projection watch (`docs/ARCHITECTURE.md:413-416`) replaces a kind's shared upstream by a watch of full objects, so one person's custom column makes every list of that kind re-list at full-object size, and a plain object watch would lose the server's Ready, Status and Restarts cells unless it is a Table with `includeObject=Object`.
- A better hybrid already exists in the code: the metrics columns are a second source joined to rows by key inside the query view (`crates/twigo-cache/src/view.rs:108-118`).
  Generalise it into ref-counted sidecar stores that hold only extracted fields (JSONPath columns, a pod's node facts, a claim's devices), watched only while a view shows the column.
  One mechanism then serves custom columns, the extension's resource columns and the AI-workload views of 2.3.10.
- The IPC must reserve this before it freezes: `ListQuery` names columns by display name only (`crates/twigo-ipc/src/list.rs:41-58`), so a column needs an identity with a source, and `Syncing` needs a per-part status and a total (`crates/twigo-ipc/src/list.rs:251-271`).

#### Bet 4: dependence on kube-rs and k8s-openapi

**2.4.15 Twigo already owns most of the client stack; the cost is upkeep, and part of it can go upstream.**
Fact for the state (2026-11-14); the estimate: Judgement (confidence: low to medium).

- Twigo replaced kube's exec auth, proxy selection, HTTP/2 set-up, watcher and discovery (`docs/ARCHITECTURE.md:296-298`, `387`, `587`, `1751-1753`, `1818-1821`); `twigo-kube` and `twigo-cache` hold about 20,000 lines under `src` outside test files and fakes (`find | wc` at `52d2c28f`).
- kube shipped three majors in 2026, and 5.1.0 came on 2026-11-12 while the repository pins 5.0.0 (`Cargo.toml:66`) ([releases](https://github.com/kube-rs/kube/releases), accessed 2026-11-14).
  5.0 added `NO_PROXY` and 5.1 corrected it, so part of the owned proxy logic now exists upstream; HTTP/2 does not, its pull request a draft since January 2026 ([kube#1823](https://github.com/kube-rs/kube/pull/1823)).
- k8s-openapi follows each Kubernetes minor by 10 to 93 days and is one person's repository ([releases](https://github.com/Arnavion/k8s-openapi/releases), accessed 2026-11-14).
  Twigo is nearly immune, because lists and editors are untyped; keep typed APIs out of the data path.
- kube-rs itself is a low risk: six maintainers and a release two days before this review ([maintainers](https://kube.rs/maintainers/), accessed 2026-11-14).
- What client-go has and this stack lacks is listed honestly in `TODO.md:6-19`; the items most likely to meet a beta user are the exec review and kuberc below.

**2.4.16 Two client-go behaviours to match before the beta.**
Fact (verified upstream at v1.37.2); whether Twigo's access review already asks both verbs: not verified.

- A WebSocket upgrade is a GET, and from 1.35 the server also checks `create` on exec, attach and port-forward ([`subresources.go` at v1.37.2](https://github.com/kubernetes/kubernetes/blob/v1.37.2/pkg/registry/core/pod/rest/subresources.go): `ensureAuthorizedForVerb(ctx, r.Authorizer, "create")`).
  A role that grants only `create` on `pods/exec`, the classic rule, works with kubectl through its SPDY fallback and fails with a WebSocket-only client on every release.
  The review should ask `get` always and `create` from 1.35, and a refusal should name the missing verb.
- kuberc gained a policy and an allowlist for exec credential plugins as beta in 1.35, "available to all clients using the `client-go` library" ([Kubernetes blog](https://kubernetes.io/blog/2026/01/09/kubernetes-v1-35-kuberc-credential-plugin-allowlist/), 2026-01-09).
  Twigo's trust store (`crates/twigo-core/src/trust.rs`) does not read it, so an organisation's `DenyAll` or allowlist is silently not honoured.

**2.4.17 D12, the version floor: keep 1.33 as the tested floor, and do not refuse below it.**
Fact for the dates; the recommendation: Judgement (confidence: medium).

- Upstream supports 1.35 to 1.37 today ([Kubernetes releases](https://kubernetes.io/releases/), accessed 2026-11-14), and 1.38 is planned for 2026-12-16 ([release schedule](https://github.com/kubernetes/sig-release/blob/master/releases/release-1.38/README.md), default branch, accessed 2026-11-14).
  1.33 and 1.34, both inside the floor, are already out of upstream support (2026-06-28 and 2026-10-27, [endoflife.date](https://endoflife.date/kubernetes), accessed 2026-11-14).
- 1.32 stays in paid support on the managed services into February and March 2027 ([EKS](https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html), [GKE](https://docs.cloud.google.com/kubernetes-engine/docs/release-schedule), [AKS](https://learn.microsoft.com/en-us/azure/aks/supported-kubernetes-versions), accessed 2026-11-14).
- "No legacy discovery" and "no SPDY" are right; "no fallback for streaming lists" is wrong as built (2.4.13).
- The CI matrix needs 1.38 on the day kind publishes its image (`.claude/rules/kubernetes-versions.md`).

### 2.5 Anything else that matters

**2.5.1 Scope against capacity: M3 can be written by one person, and it is the wrong beta.**
Fact for the state; the judgement: confidence high.

- Writing is not the constraint: nine feature pull requests of 5,000 to 38,000 lines landed in eight days (`git log --shortstat`).
- Everything M3 names is at zero lines: the MCP server, the extension host and its API, the settings files and their UI, the keybindings editor, the updater, signing, a release workflow and user documentation (`docs/ARCHITECTURE.md:2223-2224`; 2.1.7).
- Four costs do not shrink with writing speed, and the plan schedules all four last.
  Trust plumbing is bound to the calendar: Apple enrolment and notarization, Homebrew's age and notability gates, a Windows identity.
  Verification needs machines and clusters the maintainer does not own: the document's own first-minute risk is the diversity of sign-in (`docs/ARCHITECTURE.md:2203`), and every budget comes from one laptop.
  Each shipped subsystem becomes an issue queue for a person with two other products.
  And wasmtime, the MCP specification, Monaco and a pinned xterm beta all move without being asked.
- A bug report can carry nothing today: the crates and the shell log through 72 `eprintln!` calls outside tests and no logging crate (a grep at `52d2c28f`; no manifest names one), so an app started from the Dock leaves no trace, and the Output panel is "later" (`docs/ARCHITECTURE.md:713`).

The beta I would ship, in order.

1. A release pipeline before any M3 feature: a tag builds a signed and notarized macOS dmg, deb and rpm, with signed updater artifacts, and the updater is proven on one real update.
2. Diagnostics: a logging crate, a rotating local log, a panic hook, a stable code on every error state, and a "Report a problem" command that shows a redacted report and opens a pre-filled issue.
3. The fixes that decide a first impression on a real cluster: compression and the stream-budget cliffs (2.4.10, 2.4.11), the streaming-list fallback (2.4.13), the two kubeconfig items that touch the person's own files (`TODO.md:5`, `TODO.md:17`).
4. The safety model made true: the lock's setter, the default for an unmarked remote context, the audit's coverage, a `User-Agent` (2.1.2 to 2.1.5).
5. What M1 and M2 built, split in the README into a narrow supported tier (connect, browse, logs, exec, edit with a diff, scale, restart, delete, port-forward) and a preview tier for the rest; rollback to a revision joins the supported tier (2.2.3).
6. `settings.json` and `keybindings.json` with a schema, and no settings UI layers and no keybindings editor.
7. Six pages of documentation: install, first connection by provider, keyboard, the safety model, coming from Lens or k9s, and what Twigo sends over the network.
8. Then, as a second beta with its own story: the MCP server, read-only, on the actor model of 2.3.4.

What does not earn its cost before 1.0: the WASM host, the WIT API, the guest SDK, package signing and a registry (2.4.9); tier-2 frames, ever; the ACP panel; the MCP gateway; an HTTP endpoint for MCP; the keybindings editor; the notification centre; a second window.
Helm read is the next planned step and small; let it ship as preview and never let it hold the release.

**2.5.2 Distribution: signing is the entry ticket, and Windows is larger than Linux.**
Fact (read on 2026-11-14).

- "We will disable all Homebrew/homebrew-cask casks that fail Gatekeeper checks in September 2026" ([Homebrew 5.0.0](https://brew.sh/2025/11/12/homebrew-5.0.0/), 2025-11-12); the cask of a Tauri Kubernetes client was disabled on 2026-10-04 with `fails_gatekeeper_check` ([cask API](https://formulae.brew.sh/api/cask/jet-pilot.json)).
- homebrew-cask asks for a repository at least 30 days old and "at least 90 forks, 90 watchers or 225 stars for a self-submission by the repository owner" ([acceptance policy](https://docs.brew.sh/Package-Acceptance-Policy), accessed 2026-11-14), so an own tap comes first.
- Homebrew is under a tenth of comparable clients' macOS downloads: the arm64 dmg of Freelens 1.10.3 was downloaded about 13,650 times per 30 days (59,138 in 130 days) against 1,337 cask installs in 30 days (release and cask APIs above).
- Platform shares of the desktop downloads of Freelens 1.10.3 and Headlamp 0.45.0: macOS 59 to 67 %, Windows 24 to 31 %, Linux 9 to 11 % of direct downloads; Freelens 2.0.0, seventeen days old, stands at 17 % for Linux.
- Flatpak: the document's reason for excluding it holds (`docs/ARCHITECTURE.md:2156`); Freelens is on Flathub by leaving the sandbox with a fixed list of tool names ([Freelens manifest](https://github.com/flathub/app.freelens.Freelens/blob/master/app.freelens.Freelens.yaml), accessed 2026-11-14), which brings Freelens about 750 installs a month ([Flathub stats](https://flathub.org/api/v2/stats/app.freelens.Freelens)).
- Windows signing: "Individual developers are currently limited to the USA and Canada" for Microsoft's low-cost service, and no certificate skips SmartScreen any more ([Microsoft Learn](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options), 2026-11-10).
  Reputation accrues to one identity, so the identity has to be chosen before the first Windows build.
- A foundation does not bring signing: "currently Headlamp's desktop apps are not being signed and this is having a negative impact in the project" ([cncf/sandbox#393](https://github.com/cncf/sandbox/issues/393), 2025-06-12).
- The update endpoint is compiled into every installed copy, and D10 points it at a repository path (`docs/ARCHITECTURE.md:26`); the updater key can never be lost: "if you lose this key you will NOT be able to publish new updates to the users that have the app already installed" ([Tauri updater](https://v2.tauri.app/plugin/updater/), 2025-11-28).

Recommendation: enrol with Apple now, under a name that is not the platform company's; serve updates from a domain the project controls with the repository as a second endpoint; write down who else holds the updater key; ship deb and rpm and no AppImage (2.4.6); start the Windows identity paperwork; label Linux a preview until it is measured.
Effort M, calendar-bound, so it starts first.

**2.5.3 Launch: release early and quietly, launch late and with a reason.**
Judgement (confidence: medium); the base rates are facts.

- At least eighteen Show HN posts of desktop Kubernetes clients since 2022 scored 1 to 13 points, and the five of this year 3 to 6 (ten queries of the [HN search API](https://hn.algolia.com/api/v1/search?tags=show_hn&query=kubernetes+desktop) with `tags=show_hn`, counted by title, accessed 2026-11-14).
- Growth in this category came from displacement and from a trial that takes seconds: Bruno went from 490 stars to about 9,500 in the 90 days after Insomnia required an account, Freelens gained 1,211 in 90 days on a 2-point post as OpenLens died (GH Archive counts), and Radar installs with one line as a kubectl plugin.
- A displaced audience exists now: OpenLens's deprecated cask still draws 691 installs a month.

So: an alpha of at least fifteen people outside the maintainer's circle, on their own clusters, before any M3 feature; a written gate for going public (for instance: fifteen reached a real cluster, eight still used it a week later, no supported sign-in method has an open "cannot connect"); a quiet release; then a launch built around something checkable: a benchmark anyone can rerun, sent to the other clients' maintainers for corrections first, a sixty-second recording with the keys on screen, and an engineering post.
A "try it in your browser" demo can come from the recorded traffic that replaces the mock (2.1.12): a static site that replays real sessions, labelled as a UI demo; until then the mock can serve.
Write the stop or park criterion down with a date before the launch; the previous product had none.

**2.5.4 Learning what users need with no telemetry.**
Judgement (confidence: medium); the counters are facts.

- GitHub counts every fetch of a release asset, an update manifest included: one Tauri app's `latest.json` shows 559 fetches in ten days ([kftray releases API](https://api.github.com/repos/hcavarsan/kftray/releases), accessed 2026-11-14).
  One static manifest per platform, checked once a day, gives daily active installs by platform with nothing sent but a GET.
- Say so on first run: "Twigo asks GitHub once a day whether a newer version exists. GitHub counts those requests and we publish the count. You can turn it off."
  An update check is a network call, and hiding it behind "no telemetry" would be the discovery that costs trust.
- Reports the person sends on purpose: the "Report a problem" command, stable error codes that make issues countable by cause, and a compatibility form (provider, sign-in method, system, works or not) that feeds a public table.
- A public roadmap as issues sorted by votes, seeded with every cut feature, turns the cuts into a demand survey.
- One fifteen-minute conversation a week; at this size five interviews outweigh a dashboard.

**2.5.5 Sustainability: keep it small enough to idle, and make a login wall structurally impossible.**
Judgement (confidence: medium).

- Donations pay for a certificate, not for a person: k9s has 134 sponsors at 35,000 stars ([GitHub Sponsors](https://github.com/sponsors/derailed)) and Freelens 14 ([GitHub Sponsors](https://github.com/sponsors/freelensapp), both accessed 2026-11-14).
- A paid closed client is Aptakube's position, and it now has a free tier ([pricing](https://aptakube.com/pricing), accessed 2026-11-14); open core by seat is what created Freelens.
- The honest economics: Twigo earns reputation and onboarding for the maintainer's platform and operator, and costs almost nothing to run because it has no server.
  Say so in public.
- Decide before the beta: Apache-2.0 with DCO and no contributor agreement; a trademark policy; the name, the domain, the signing identity and the updater key held by the maintainer in person with a second holder, never by the platform company; a written "never" list (no account, nothing free today behind payment, no project-run server in the core's path, no vendor code in the core).
- Every subsystem cut in 2.5.1 lowers the hours needed to keep Twigo alive, which is the real continuity plan.

**2.5.6 Synergy with the maintainer's platform and operator without capture.**
Judgement (confidence: medium-high).

- The plan itself reads as capture today: the MVP's only extension consumer is the maintainer's platform (`docs/ARCHITECTURE.md:2174`), and the worked example of the provider model is the same platform (`docs/ARCHITECTURE.md:1692-1701`).
  Replace the example by a neutral provider and keep the platform's notes in the platform's repository.
- The platform needs no extension at the beta: its CLI can write the exec entry and the `twigo` kubeconfig metadata the core already reads, environment, colour and `readOnly` (`docs/ARCHITECTURE.md:1680-1683`), and every other client keeps working with the same file.
- Whatever the platform needs from the core is specified as a general feature with a second user first.
  The provider protocol of 2.4.9 should be proven on a provider nobody sells, local kind and k3d clusters or a Cluster API management cluster, before the platform's.
- The operator's custom resources are served by what serves every CRD: printer columns, conditions, and later a data-only pack of columns, health rules and sections, shipped from the operator's repository next to packs for Argo CD, Flux, cert-manager and Gateway API.
  "Clusters from a management cluster" is the vendor-neutral form of what the operator's users want, and Headlamp already has a Cluster API plugin ([Kubernetes blog](https://kubernetes.io/blog/2026/06/25/headlamp-cluster-api-plugin/), 2026-06-25).
- Make it checkable: a disclosure in the README's first screen, a CI job that fails if a vendor's name appears under `crates/`, `packages/` and `apps/`, and promotion that runs one way only.

**2.5.7 Security: what is left after 2.1 and 2.3.**
Fact (verified) unless marked.

- Kubeconfig trust covers exec plugins by a digest of the command as written, its arguments and environment (`crates/twigo-kube/src/credentials/exec.rs:202-204`), not the binary the login shell's `PATH` resolves it to, and it does not read kuberc's plugin policy (2.4.16).
  The server, `proxy-url` and file paths of an untrusted kubeconfig are as dangerous here as in kubectl; the review dialog should say so.
- Monaco 0.57.0 imports a vendored copy of DOMPurify 3.4.15 (`esm/vs/base/browser/domSanitize.js:4` of the installed package; the lockfile lists the same version as a dependency, `pnpm-lock.yaml:5861-5863`), so an update of the npm package would not change what the editor runs, and descriptions from a cluster's CRDs reach its hover (`crates/twigo-kube/src/openapi/schema.rs:215`).
  Judgement: the risk is low while the CSP forbids inline script; a build alias to the npm package and one test with a hostile description keep it low.
- About 550 npm packages and 684 crates are locked (`pnpm-lock.yaml`, `Cargo.lock`), and every npm package runs with the webview's rights over sixty commands; the release-age gate is one day (`.claude/rules/checks.md:70`), actions are pinned by tag, and no job runs `cargo deny`.
  A gate of a week, actions pinned by commit and `cargo deny` are about a day's work, by my estimate.
- The updater plugin is young: its `check` command lost the `allowDowngrades` option in 2.12.0 and a failed macOS install stopped deleting the installed app in 2.13.2 ([updater release notes](https://v2.tauri.app/release/updater/), 2026-09-20 and 2026-10-07).
  Start at the newest release and check the installed bundle's version after the signature.

**2.5.8 Sustainability of the code: what a second contributor, human or agent, needs.**
Judgement (confidence: medium).

- No map: a 2,262-line document is a reference, not an entry (2.1.8).
  One page with the crates and packages in a line each, the path of a click to the API server, and the five rules a change must not break would do more than the rest together.
- The shortest path is hidden: `CONTRIBUTING.md:7-17` asks for a Rust toolchain and starts the app on the newcomer's own kubeconfig, while the mock needs only pnpm and no cluster.
- Context files for agents can cost more than they return: a 2026 study found they do "not generally improve task success rates" while "increasing inference cost by over 20% on average", and are useful "for specifying non-standard coding practices" ([arXiv 2602.11988](https://arxiv.org/abs/2602.11988), 2026-02-12, revised 2026-09-29).
  That is an argument for 2.1.8 and 2.1.10, not against rules.
- `TODO.md` holds dozens of exact, small gaps; twenty of them as issues with a reproduction that needs no cluster are the afternoon-sized work a stranger can land.
- Say in the README that the code is written with heavy AI assistance and how it is held to account (recorded fixtures, the 1.33 to 1.37 matrix, live tests, the bench).
  Thirty-eight commits of this size show it anyway, and a reader who discovers it trusts less than a reader who is told.
- Release succession: a written procedure, a second owner of the organisation, the updater key with a second holder.
- A test of the whole: once a month give a fresh agent only the public repository and five seeded issues, and count how many it lands correctly; the number is the bus factor made measurable.

## 3. Prioritised backlog

Effort is for one maintainer with agents: S is days, M is one to two weeks, L is more.
Rows are in order of priority within each horizon.

| #   | Item                                                                                                                                                                                                                            | Area    | Why                                                                                                                   | Evidence                     | Effort  | Horizon                                   | Confidence                              |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------- | ----------------------------------------- | --------------------------------------- |
| 1   | Release pipeline: signed and notarized macOS build, deb and rpm, updater on a project domain with a second key holder, own Homebrew tap                                                                                         | 5       | Calendar-bound, and nothing can be learnt from users without it                                                       | 2.5.2                        | M       | Before beta, first                        | High                                    |
| 2   | Lowering protection becomes a bus command with friction and an audit line (mode, type, unlock, plugin trust); kubeconfig metadata only tightens                                                                                 | 1       | The lock's setter is its weakest link                                                                                 | 2.1.2                        | S       | Before beta                               | High                                    |
| 3   | A migration and a fixture for every file a person keeps; the person's locks in a file that reads closed                                                                                                                         | 1       | After a format bump or a damaged file a context the person locked is `read-write` again                               | 2.1.19                       | M       | Before beta (its first build)             | High                                    |
| 4   | Compress lists: gzip on paged lists on every release and on streaming lists from 1.37, where the measured throughput calls for it                                                                                               | 4       | First paint on every remote cluster is bounded by bytes                                                               | 2.4.10                       | S–M     | Before beta                               | High                                    |
| 5   | Isolate streams that can stall (the proxy's own connection, or sized windows) and put a total timeout on the idle probe                                                                                                         | 4       | Three paused child streams freeze a cluster's connection                                                              | 2.4.11                       | S       | Before beta                               | High for the mechanism                  |
| 6   | Streaming-list support per API group, with a watchdog and a fallback on any refusal or silence                                                                                                                                  | 4       | Lists that never load where kubectl works                                                                             | 2.4.13                       | S       | Before beta                               | High                                    |
| 7   | Show the rows of ready parts when another part is queued or forbidden; count before listing to scope by cost                                                                                                                    | 4       | A namespace-scoped person sees an empty list; five namespaces download a cluster                                      | 2.4.11                       | S–M     | Before beta                               | Medium-high                             |
| 8   | A panic policy: `Core::run` split into supervised tasks, a panic hook that logs, a panicked run ends its plan as failed                                                                                                         | 1       | One panic silently stops unlock expiry and forward checks; a plan can hang for good                                   | 2.1.18                       | S–M     | Before beta                               | High                                    |
| 9   | Diagnostics: a logging crate, a local log, a panic hook, stable error codes, "Report a problem"                                                                                                                                 | 5       | A bug report can carry nothing today                                                                                  | 2.5.1                        | M       | Before beta                               | High                                    |
| 10  | Measure what will be claimed: 20k, 50k and 200k pods, a WAN profile, Linux desktops, a mid-range machine, a 120 Hz panel; add launch to first rows, key to paint and total memory; publish the comparison                       | 1, 2, 4 | Every claim rests on 5,000 pods on loopback on one laptop                                                             | 2.1.15, 2.4.2, 2.4.3, 2.4.12 | M       | Before beta                               | High                                    |
| 11  | Re-scope M3: no WASM host, WIT, SDK, signing or registry; no keybindings editor or settings UI layers; `settings.json` and `keybindings.json`                                                                                   | 4, 5    | The largest unbuilt part serves one first-party provider                                                              | 2.4.7 to 2.4.9, 2.5.1        | Saves L | Before beta (decide now)                  | High                                    |
| 12  | An actor with an identity for every non-human caller, grants checked at the gate and at the tool, and no write path for MCP and extensions in any mode                                                                          | 1, 3    | M3's actors would inherit `read-write`                                                                                | 2.1.3, 2.3.3, 2.3.4          | M       | Before beta (before any agent path ships) | High                                    |
| 13  | Audit, second version: every class but plain reads for non-UI actors, the lock's changes, rotation; `User-Agent: twigo/<version> (<actor>)`                                                                                     | 1, 3    | "Audit" is a write log today, and the cluster cannot tell Twigo's requests                                            | 2.1.4                        | S–M     | Before beta                               | High                                    |
| 14  | A dry run to a group that an APIService hands to another server is a write                                                                                                                                                      | 1       | Two paths answer one question differently                                                                             | 2.1.5                        | S       | Before beta                               | Medium                                  |
| 15  | Webview hardening: three CSP directives, a navigation guard, the mock out of release builds, a lint on HTML sinks, Monaco's sanitizer aliased to the npm package                                                                | 1, 5    | The webview is the trust root                                                                                         | 2.1.6, 2.5.7                 | S       | Before beta                               | Medium                                  |
| 16  | Pause before asking a row's capabilities, and ask by name only when a command runs; an error boundary around every contributed surface                                                                                          | 1       | A viewer's cursor sends access reviews per row; one render error restarts into itself                                 | 2.1.23, 2.1.24               | S       | Before beta                               | High for the paths                      |
| 17  | Ask what a context is at the first write to an unmarked remote context                                                                                                                                                          | 1, 2    | "Safe by default" with a `read-write` default                                                                         | 2.2.3                        | S       | Before beta                               | High                                    |
| 18  | Rollback to a revision, with a diff                                                                                                                                                                                             | 2       | The incident's own action is missing                                                                                  | 2.2.3                        | S–M     | Before beta                               | High                                    |
| 19  | Before the contracts freeze: an `Origin` handle in place of `window: &str`, newtypes for context, space and connection, write-capable clients only for a plan's run, unused wire variants removed                               | 1       | M3's callers have no window, identifiers swap silently, and only a grep keeps writes in the bus                       | 2.1.20                       | M–L     | Before beta                               | Medium-high                             |
| 20  | Reserve in the IPC before it freezes: a column identity with a source, per-part status and a total, a plan's origin and a proposal id, a stable error `code`, the evidence bundle's schema, `twigo://` addresses by fingerprint | 1, 3, 4 | Cheap now, breaking later                                                                                             | 2.1.13, 2.3.7, 2.4.14        | S–M     | Before beta                               | Medium-high                             |
| 21  | Normalise the contract: struct requests, a `hello` with a version and limits, an integer policy, tone and typed facts on rows from Rust, a typed registry of context keys, `when` and key grammars held by shared cases         | 1, 4    | Ten commands take a bare `String`; the webview re-derives meaning from printed cells; an unknown key reads false      | 2.1.25, 2.4.5                | M       | Before beta                               | High                                    |
| 22  | One position in the README and the first lines of the architecture; the stale status fixed; a status word per section                                                                                                           | 1, 2    | Three positions in three places; design and fact are indistinguishable                                                | 2.1.7, 2.2.4                 | S       | Before beta                               | High                                    |
| 23  | An alpha of fifteen or more outsiders on their own clusters, a written gate for going public, a stop criterion with a date, partners with fleets                                                                                | 2, 5    | Sign-in diversity cannot be tested alone; the last product had no stopping rule                                       | 2.5.3                        | S       | Before beta                               | High                                    |
| 24  | Neutrality package: a README disclosure, a CI check on vendor names, a neutral worked example in 5.5, marks and keys held in person                                                                                             | 5       | A sceptic checks this first                                                                                           | 2.5.5, 2.5.6                 | S       | Before beta                               | High                                    |
| 25  | CI: build the app on macOS, `cargo check` for Windows allowed to fail, actions pinned by commit, `cargo deny`, a Rust-side memory guard                                                                                         | 1, 5    | The measured platform is never built; the Windows debt grows unseen                                                   | 2.1.16, 2.5.7                | S       | Before beta                               | High                                    |
| 26  | The exec review asks `get` always and `create` from 1.35; honour kuberc's plugin policy                                                                                                                                         | 4       | Wrong offers and refusals; an organisation's policy bypassed                                                          | 2.4.16                       | S       | Before beta                               | High upstream, not verified in the code |
| 27  | Split `ARCHITECTURE.md` by lifetime; split `checks.md`; a one-page map                                                                                                                                                          | 1, 5    | Nobody, person or agent, can read 48,900 words before a change                                                        | 2.1.8, 2.1.10, 2.5.8         | M       | Before beta                               | High                                    |
| 28  | A WebKitGTK floor of 2.50, the engine version in diagnostics, a GPU shim and a `--safe-rendering` flag                                                                                                                          | 4       | Turns a blank window into a supported path                                                                            | 2.4.3, 2.4.6                 | S       | Before beta                               | Medium-high                             |
| 29  | Read the server's stream limit, scale the budgets, dial a second connection when a class is full                                                                                                                                | 4       | 24 watches are too few for namespace-scoped users, and the fixed 100 streams are a twentieth of what OpenShift allows | 2.4.11                       | M       | Beta                                      | Medium-high                             |
| 30  | The MCP server: ten read-only tools over the stdio shim on the 2026-07-28 revision, structural redaction, grants in the app                                                                                                     | 3       | The beta's AI story, as a second release                                                                              | 2.3.6                        | L       | Beta (second)                             | Medium-high                             |
| 31  | The hand-off: Copy as prompt, an agent terminal profile that is always proxied, three to five MCP prompts                                                                                                                       | 3       | One click without an LLM client                                                                                       | 2.3.5                        | S       | Beta                                      | High                                    |
| 32  | Replace the mock as a second implementation: the real core behind a development-only transport, a small scripted fake and recorded traffic for component tests, a browser smoke test with an accessibility pass                 | 1       | Every backend change is written twice, and the copies already disagree                                                | 2.1.12, 2.1.26               | M–L     | Beta (start before it, finish after)      | High                                    |
| 33  | One flush loop and one backoff policy shared by the crates                                                                                                                                                                      | 1       | A fourth copy arrives with M3                                                                                         | 2.1.14                       | S       | Beta                                      | Medium                                  |
| 34  | A test kit: one fake API server, one `TestCore`, one live `Cluster`, one integration binary per crate; tests for a lost acknowledgement, a panic and a `410` status                                                             | 1       | More than a dozen fakes, 41 test binaries, and four behaviours with no test                                           | 2.1.21, 2.1.22               | M       | Beta                                      | Medium                                  |
| 35  | Count without telemetry: one update manifest per platform, a daily public count, the disclosure on first run                                                                                                                    | 5       | No number exists for "does anyone use it"                                                                             | 2.5.4                        | S       | Beta                                      | Medium                                  |
| 36  | What changed: managers and times from managedFields, revisions, Helm history, GitOps status                                                                                                                                     | 2, 3    | The step no client has taken; needs no prior run                                                                      | 2.2.3, 2.3.7                 | M       | Beta                                      | Medium                                  |
| 37  | Field owners in the dry-run diff, with the source of truth                                                                                                                                                                      | 2       | A controller often owns what the person edits                                                                         | 2.2.3                        | S–M     | Beta                                      | Medium                                  |
| 38  | For k9s users: aliases and hotkeys imported, a which-key overlay, a test that drives core flows with no pointer                                                                                                                 | 2       | The largest engaged audience, at the lowest switching cost                                                            | 2.2.1, 2.2.3                 | S       | Beta                                      | Medium                                  |
| 39  | An instant first screen: the home's last snapshot with its age, the login environment reused while it resolves again                                                                                                            | 2       | Launch to first rows has no budget and waits on a shell                                                               | 2.1.15, 2.2.3                | S–M     | Beta                                      | Medium                                  |
| 40  | Fleet attention for pinned contexts, counted from workloads, nodes and warnings; then merged reads as a k-way merge, writes in the object's own space                                                                           | 2       | The wedge                                                                                                             | 2.2.3, 2.2.4, 2.4.12         | M–L     | v1.x, first                               | Medium                                  |
| 41  | Sidecar columns with a JSONPath evaluator; data-only packs of columns, health rules and sections for five CRD families                                                                                                          | 2, 4    | Custom columns have 199 votes in k9s; the compounding part of extensions                                              | 2.2.1, 2.4.14, 2.4.9, 2.5.6  | M–L     | v1.x                                      | Medium                                  |
| 42  | The provider protocol over a remote endpoint and exec, proven on a neutral provider; a Cluster API or ClusterProfile source                                                                                                     | 4, 5    | Third-party providers without foreign code in the process                                                             | 2.4.9, 2.5.6                 | M       | v1.x                                      | Medium-high                             |
| 43  | Draft change sets (`propose_change`) and what-if plans as tools                                                                                                                                                                 | 3       | Where Twigo can beat Lens's flow with a server-side diff                                                              | 2.3.4, 2.3.7                 | L       | v1.x                                      | Medium                                  |
| 44  | Windows: the port of the terminal, environment and credential crates, the identity, the frame and IPC measurements                                                                                                              | 2, 5    | A quarter to a third of the category's downloads                                                                      | 2.1.16, 2.5.2                | L       | v1.x, after fleet attention               | Medium                                  |
| 45  | Compact rows and a handle-based index                                                                                                                                                                                           | 4       | A row costs about 2.2 KB today; needed before merged tables                                                           | 2.4.12                       | L       | v1.x                                      | Medium-high                             |
| 46  | GPU columns on nodes, a device-pool view, pending reasons; Kueue as a first-party pack                                                                                                                                          | 3       | Parity with Lens and Headlamp in shared GPU clusters, and one join neither shows: why a job does not start            | 2.3.10                       | M       | v1.x                                      | Low to medium                           |
| 47  | Upstream HTTP/2, the credential runner and ETag discovery to kube-rs                                                                                                                                                            | 4       | Shares the upkeep of the owned stack                                                                                  | 2.4.15                       | M       | v1.x (spread)                             | Medium                                  |
| 48  | Spikes for the 2028 decision: the pod list on GPUI against `twigo-core`; Tauri 3 with bundled Chromium on Linux                                                                                                                 | 4       | Puts numbers on the two ways out                                                                                      | 2.4.4 to 2.4.6               | M       | v1.x, or before the beta if Linux fails   | Medium                                  |
| 49  | Custody: a kubeconfig whose server is the proxy and whose user is a Twigo exec plugin                                                                                                                                           | 3       | The only real closure of the `~/.kube/config` bypass                                                                  | 2.3.4                        | L       | Later                                     | Low to medium                           |
| 50  | A Kubernetes YAML language service in Rust                                                                                                                                                                                      | 4       | The longest pole of any renderer change and the weakest dependency chain                                              | 2.4.5                        | L       | Later                                     | Medium                                  |

## 4. Decisions to make

Questions only the maintainer can answer, each with my recommended answer and what it costs.
The answers given on 2026-11-14 to questions 1, 3, 4, 5, 6 and 9 are recorded as D13 to D17 in section 0.1 of [`ARCHITECTURE.md`](../ARCHITECTURE.md).

1. **What is Twigo's one position?**
   Recommended: triage for the operator of many clusters, from the keyboard, safely; "performance" as the proof, not the pitch.
   Trade-off: it gives up "an open Lens" and the developers who want a dashboard, for an audience that is smaller, engaged and badly served.
2. **Does the beta wait for the fleet view?**
   Recommended: no.
   Ship single-cluster triage to partners first, fix what real clusters break, and build fleet attention for pinned contexts right after.
   Trade-off: the first release looks more like the others; the alternative is a fleet view on a data path nobody has run past 5,000 pods or off loopback.
3. **Is the WASM extension runtime cut from the beta, and from 1.0 unless someone asks?**
   Recommended: yes; tier 0 as data, then a provider protocol proven on a neutral provider.
   Trade-off: D3's promise of an open ecosystem waits, and the platform arrives through the kubeconfig and its exec plugin like any vendor.
4. **Is the public claim about agents "read and propose" or "act with approval"?**
   Recommended: read and propose.
   Trade-off: no demo of an agent fixing a cluster without the person's click; a claim that holds and can be tested.
5. **What happens at the first write to a context nobody marked?**
   Recommended: ask once what it is, and suggest Production from its name.
   Trade-off: one more question in the first session, against a selling point that is true.
6. **May a click or a kubeconfig lower a lock silently?**
   Recommended: no; lowering is a confirmed, audited command, and files only tighten.
   Trade-off: one prompt per context for teams that ship kubeconfigs marking development clusters.
7. **Does Linux ship as supported or as a preview?**
   Recommended: a preview until the harness has run on real WebKitGTK desktops, with bundled Chromium as the named fallback.
   Trade-off: a weaker launch among Linux users, against a blank window on a common GPU on day one.
8. **When does Windows ship, and under which signing identity?**
   Recommended: as the first platform milestone after the beta, behind fleet attention; choose the identity now, since reputation does not move with it.
   Trade-off: a second platform's bugs while the first users' reports still come in, against leaving a quarter of the category unserved.
9. **Who holds the name, the domain, the signing identity and the updater key?**
   Recommended: the maintainer in person, with a second holder, never the platform company.
   Trade-off: some paperwork and shared control, against the asset that dies first when a sponsor changes.
10. **How is Twigo funded, and is the "never" list public?**
    Recommended: say that the maintainer's business pays for it, publish the list (no account, nothing free today behind payment, no project-run server in the core's path, no vendor code in the core), and take company supporters from 1.0.
    Trade-off: no income from the client; the alternative, a commercial licence on the official builds, would make Twigo a rival of the paid clients and would have to be announced before the first user arrives.
11. **Is "no telemetry" compatible with a public count of update checks?**
    Recommended: yes, disclosed on first run, with a switch.
    Trade-off: no knowledge of which features are used beyond what people choose to send.
12. **How visible is the way the code is written?**
    Recommended: say it in the README and lead with how it is verified.
    Trade-off: some readers leave at once; discovery later costs more.
13. **Will memory be reported with WebKit's GPU process?**
    Recommended: yes, with the explanation `docs/bench.md` already has.
    Trade-off: a less flattering number, published by the project instead of found by a critic.
14. **What result, by which date, means stop or park?**
    Recommended: write it before the launch, for instance a number of daily update checks ninety days after the beta and a number of partners who used it in a real incident.
    Trade-off: none worth naming; the numbers are the maintainer's to set.
15. **Is 1.33 a hard floor?**
    Recommended: the tested floor, a warning below it.
    Trade-off: one more matrix entry, against refusing clusters in paid extended support.
16. **Who else can cut a release?**
    Recommended: one more person with release rights before 1.0.
    Trade-off: sharing control, against a bus factor of one.
17. **Should commits name competitors' issues?**
    A commit of 2026-11-01 names `lensapp/lens#8101` in its body (`git log --grep`), and that issue's timeline shows the reference (the GitHub API, read by a verification agent on 2026-11-14).
    Recommended: cite such issues in documents, not in commit messages, until the launch.
    Trade-off: none.

## 5. Sources

Every URL cited above, with its date.
"Accessed" means read on 2026-11-14 on a page that shows no date of its own.
Upstream code is cited at a tag or a commit; two READMEs, a manifest and a release schedule were read at their default branch that day and are marked so.
The repository itself was read at `52d2c28f`.

### Kubernetes upstream

- https://kubernetes.io/releases/ — accessed 2026-11-14
- https://github.com/kubernetes/sig-release/blob/master/releases/release-1.38/README.md — default branch, accessed 2026-11-14
- https://endoflife.date/kubernetes — accessed 2026-11-14
- https://docs.aws.amazon.com/eks/latest/userguide/kubernetes-versions.html — accessed 2026-11-14
- https://docs.cloud.google.com/kubernetes-engine/docs/release-schedule — accessed 2026-11-14 (page updated 2026-11-10)
- https://learn.microsoft.com/en-us/azure/aks/supported-kubernetes-versions — accessed 2026-11-14 (page updated 2026-10-21)
- https://kubernetes.io/docs/reference/using-api/api-concepts/ — accessed 2026-11-14
- https://github.com/kubernetes/kubernetes/blob/v1.37.2/staging/src/k8s.io/apiserver/pkg/features/kube_features.go — tag v1.37.2
- https://github.com/kubernetes/kubernetes/blob/v1.37.2/pkg/registry/core/pod/rest/subresources.go — tag v1.37.2
- https://github.com/kubernetes/kubernetes/issues/138670 — opened 2026-04-29
- https://github.com/kubernetes/kubernetes/issues/135895 — opened 2025-12-22
- https://github.com/kubescape/storage/pull/330 — merged 2026-06-18
- https://github.com/rancher/fleet/issues/5059 — opened 2026-04-29, reopened 2026-11-04
- https://www.kubernetes.dev/resources/keps/576/ — accessed 2026-11-14
- https://www.kubernetes.dev/resources/keps/4322/ — accessed 2026-11-14
- https://www.kubernetes.dev/resources/keps/5677/ — accessed 2026-11-14
- https://kubernetes.io/blog/2026/01/09/kubernetes-v1-35-kuberc-credential-plugin-allowlist/ — 2026-01-09
- https://kubernetes.io/docs/concepts/scheduling-eviction/dynamic-resource-allocation/ — accessed 2026-11-14
- https://kubernetes.io/blog/2026/09/08/kubernetes-v1-37-advancing-workload-aware-scheduling/ — 2026-09-08
- https://kubernetes.io/blog/2026/07/13/introducing-headlamp-plugin-for-kubeflow/ — 2026-07-13
- https://kubernetes.io/blog/2026/10/14/tracing-kueue-admission-with-headlamp/ — 2026-10-14
- https://kubernetes.io/blog/2026/06/25/headlamp-cluster-api-plugin/ — 2026-06-25
- https://github.com/kubernetes-sigs/kueue/releases — accessed 2026-11-14
- https://github.com/openshift/cluster-kube-apiserver-operator/blob/268765be7155a9ab08b1d5b8976cdb371b0385c6/bindata/assets/config/defaultconfig.yaml — commit 268765be of 2023-08-14
- https://github.com/golang/net/blob/v0.38.0/http2/transport.go — tag v0.38.0
- https://github.com/hyperium/hyper/blob/v1.12.0/src/proto/h2/client.rs — tag v1.12.0
- https://github.com/hyperium/hyper/blob/v1.12.0/src/body/incoming.rs — tag v1.12.0

### kube-rs and k8s-openapi

- https://github.com/kube-rs/kube/releases — accessed 2026-11-14 (5.1.0 of 2026-11-12)
- https://github.com/kube-rs/kube/releases/tag/5.0.0 — 2026-11-01
- https://github.com/kube-rs/kube/pull/1823 — opened 2025-09-11, a draft since 2026-01-29
- https://github.com/Arnavion/k8s-openapi/releases — accessed 2026-11-14
- https://kube.rs/maintainers/ — accessed 2026-11-14

### The UI platform and the extension runtime

- https://github.com/tauri-apps/tauri/issues/13978 — closed 2025-08-11
- https://github.com/tauri-apps/tauri/issues/16189 — opened 2026-10-01
- https://github.com/orgs/tauri-apps/discussions/8524 — 2024-01-02 and 2025-03-03
- https://bugs.webkit.org/show_bug.cgi?id=294338 — 2025-08-18
- https://v2.tauri.app/develop/debug/linux-graphics/ — 2026-06-15
- https://launchpad.net/ubuntu/+source/webkit2gtk — accessed 2026-11-14
- https://packages.fedoraproject.org/pkgs/webkitgtk/webkit2gtk4.1/ — accessed 2026-11-14
- https://archlinux.org/packages/extra/x86_64/webkit2gtk-4.1/ — accessed 2026-11-14 (2.54.2)
- https://webkitgtk.org/2026/09/16/webkitgtk-2.54-highlights.html — 2026-09-16
- https://github.com/happier-dev/happier/issues/584 — 2026-10-16
- https://github.com/block/buzz/pull/3271 — merged 2026-07-28
- https://paseo.sh/blog/i-was-wrong-about-electron — 2026-05-28
- https://github.com/yicheng47/quill/issues/327 — 2026-11-10
- https://v3.tauri.app/develop/cef/ — 2026-09-13
- https://crates.io/crates/tauri-runtime-cef — accessed 2026-11-14
- https://github.com/srelens/srelens/blob/2194e83ec53e/docs/PERFORMANCE.md — commit 2194e83e, measured 2026-08-16
- https://crates.io/crates/slint — accessed 2026-11-14 (1.18.1)
- https://zed.dev/blog/zed-1-0 — 2026-04-29
- https://github.com/zed-industries/zed/issues/66275 — 2026-10-30
- https://github.com/zed-industries/zed/issues/66691 — 2026-11-08
- https://github.com/zed-industries/zed/tree/v1.27.0/crates/extension_api/wit — tag v1.27.0
- https://zed.dev/docs/extensions/developing-extensions — accessed 2026-11-14
- https://bytecodealliance.org/articles/WASI-0.3 — 2026-06-11
- https://docs.wasmtime.dev/stability-release.html — accessed 2026-11-14
- https://github.com/bytecodealliance/ComponentizeJS/issues/291 — 2025-09-08
- https://wasmcloud.com/docs/wash/developer-guide/language-support/ — 2026-08-19
- https://osv.dev/vulnerability/CVE-2026-27976 — 2026-02-25
- https://helm.sh/docs/plugins/overview — accessed 2026-11-14 (Helm 4.3.1)
- https://v2.tauri.app/plugin/updater/ — 2025-11-28
- https://v2.tauri.app/release/updater/ — 2026-09-20 and 2026-10-07

### Agents and MCP

- https://docs.lenshq.io/k8slens/mcp-server/ — 2026-11-11
- https://docs.lenshq.io/k8slens/mcp-server/how-it-works/ — 2026-11-11
- https://docs.lenshq.io/k8slens/how-to/use-dra/ — 2026-09-03
- https://www.lenshq.io/pricing/ — accessed 2026-11-14
- https://github.com/containers/kubernetes-mcp-server/blob/main/README.md — default branch, accessed 2026-11-14
- https://github.com/Azure/aks-mcp/blob/main/README.md — default branch, accessed 2026-11-14
- https://api.osv.dev/v1/query — queried 2026-11-14 for the npm package `mcp-server-kubernetes`
- https://osv.dev/vulnerability/CVE-2026-47250 — 2026-06-11
- https://osv.dev/vulnerability/CVE-2026-46519 — 2026-06-11
- https://www.solo.io/blog/announcing-kagent-1-0-ga — 2026-11-10
- https://www.anthropic.com/research/claude-code-auto-mode — 2026-03-25
- https://www.efficientlyconnected.com/komodor-2026-agentic-operations-governance-survey/ — 2026-11-09
- https://modelcontextprotocol.io/specification/2026-07-28/changelog — 2026-07-28
- https://crates.io/crates/rmcp — accessed 2026-11-14 (3.10.0 of 2026-11-12)
- https://agentclientprotocol.com/get-started/agents — accessed 2026-11-14
- https://agentclientprotocol.com/announcements/acp-v2-draft — 2026-07-20
- https://www.cncf.io/announcements/2026/01/20/kubernetes-established-as-the-de-facto-operating-system-for-ai-as-production-use-hits-82-in-2025-cncf-annual-cloud-native-survey/ — 2026-01-20

### The category

- https://api.github.com/repos/freelensapp/freelens/releases — accessed 2026-11-14
- https://api.github.com/repos/kubernetes-sigs/headlamp/releases — accessed 2026-11-14
- https://github.com/kubernetes-retired/dashboard — archived 2026-01-21
- https://api.github.com/search/repositories?q=kubernetes+desktop+in:name,description,topics+created:%3E2025-01-01&sort=stars — accessed 2026-11-14
- https://github.com/FriendsOfKubernetes/sextant — created 2026-10-11
- https://github.com/freelensapp/freelens/releases/tag/v2.0.0 — 2026-10-28
- https://github.com/freelensapp/freelens/releases — 2026-10-28
- https://github.com/freelensapp/freelens/issues/687 — closed 2026-11-12
- https://github.com/freelensapp/freelens/issues/2117 — 2026-07-09
- https://github.com/freelensapp/freelens/blob/v2.0.0/packages/core/src/renderer/components/cluster-manager/cluster-frame-handler.ts — tag v2.0.0
- https://github.com/aptakube/aptakube/releases — 1.22.0 of 2026-10-27
- https://aptakube.com/pricing — accessed 2026-11-14
- https://docs.lenshq.io/release-notes/lens-k8s-ide/lens-2026-3-130712/ — page updated 2026-05-13
- https://docs.lenshq.io/release-notes/lens-k8s-ide/lens-2026-11-91422/ — 2026-11-11
- https://docs.lenshq.io/release-notes/lens-k8s-ide/lens-2026-10-51501/ — 2026-10-08
- https://github.com/skyhook-io/radar — accessed 2026-11-14 (created 2026-01-20)
- https://radarhq.io/pricing — accessed 2026-11-14
- https://github.com/lensapp/lens/issues/5444 — 2022-05-25
- https://github.com/lensapp/lens/issues/601 — 2020-07-21
- https://github.com/lensapp/lens/issues/208 — 2020-04-02
- https://github.com/derailed/k9s/issues/755 — 2020-06-05
- https://github.com/derailed/k9s/issues/364 — 2019-10-17
- https://github.com/derailed/k9s/issues/1006 — 2021-01-08
- https://github.com/derailed/k9s/issues/4293 — 2026-10-13
- https://github.com/derailed/k9s/releases/tag/v0.51.0 — 2026-06-06
- https://github.com/kubernetes-sigs/headlamp/issues/358 — 2021-11-22
- https://github.com/kubernetes-sigs/headlamp/issues/1716 — 2024-02-14
- https://formulae.brew.sh/api/formula/k9s.json — accessed 2026-11-14
- https://formulae.brew.sh/api/cask/freelens.json — accessed 2026-11-14, and the same API for headlamp, lens, aptakube, monokle and k8studio
- https://formulae.brew.sh/api/cask/openlens.json — accessed 2026-11-14 (deprecated 2026-11-06)
- https://formulae.brew.sh/api/cask/jet-pilot.json — accessed 2026-11-14 (disabled 2026-10-04)
- https://news.ycombinator.com/item?id=50009904 — 2026-10-08
- https://news.ycombinator.com/item?id=43863418 — 2025-05-01
- https://www.mirantis.com/blog/lens-user-survey-2024-the-voice-of-our-community/ — 2025-09-18
- https://www.cncf.io/announcements/2026/03/24/cncf-and-slashdata-report-finds-cloud-native-community-reaches-nearly-20-million-developers/ — 2026-03-24

### Distribution, growth and contributors

- https://brew.sh/2025/11/12/homebrew-5.0.0/ — 2025-11-12
- https://docs.brew.sh/Package-Acceptance-Policy — accessed 2026-11-14
- https://github.com/flathub/app.freelens.Freelens/blob/master/app.freelens.Freelens.yaml — default branch, accessed 2026-11-14
- https://flathub.org/api/v2/stats/app.freelens.Freelens — accessed 2026-11-14
- https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options — 2026-11-10
- https://github.com/cncf/sandbox/issues/393 — 2025-06-12
- https://hn.algolia.com/api/v1/search?tags=show_hn&query=kubernetes+desktop — accessed 2026-11-14, one of ten queries
- https://api.github.com/repos/hcavarsan/kftray/releases — accessed 2026-11-14
- https://github.com/sponsors/derailed — accessed 2026-11-14
- https://github.com/sponsors/freelensapp — accessed 2026-11-14
- https://arxiv.org/abs/2602.11988 — 2026-02-12 (v3 of 2026-09-29)

Star counts after launches in 2.5.3 come from the public GH Archive copy at https://play.clickhouse.com/?user=play, queried on 2026-11-14.
The research agents' full notes, with every quote and several hundred further sources that this review did not cite, are not part of the repository.
