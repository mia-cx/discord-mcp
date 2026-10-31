# Hardening workerd for untrusted multi-tenant code

Research for [#19](https://github.com/mia-cx/discord-mcp/issues/19), feeding the Runners tier, Isolate host, and Broker decisions in the Textile PRD ([#15](https://github.com/mia-cx/discord-mcp/issues/15)). Nothing here touched a cluster. Upstream facts come from `cloudflare/workerd` `main` at `eed7c37` (2026-10-31) and the Cloudflare, gVisor, k3s, and Kubernetes docs listed under Sources. Experiments ran on this machine (Linux 6.12, x86_64) with the `workerd` 2026-10-31 npm binary (`1.20261031.1`).

**Marks.** **[V]** verified: stated in a cited primary source, or reproduced by an experiment recorded in §7. **[I]** inference: my reading, or something I could not check here.

## Answer in brief

1. Cloudflare says plainly that workerd is not a sandbox for hostile code: run it "inside an appropriate secure sandbox", "such as a virtual machine". **[V]** [W1]
2. Self-hosted workerd enforces **no** per-isolate CPU, memory, or subrequest limits. The local server wires in a `NullIsolateLimitEnforcer` under the comment "Single-tenant policy: no limits", `workerd.capnp` has no limit field on `Worker`, and the Worker Loader's `limits` argument is accepted and dropped. **[V]** [W2] [W3] [W4] The PRD's "per-bot CPU, memory, and isolate limits" and its "CPU limits stop a runaway isolate" test cannot be met with workerd config.
3. One tenant's `for (;;) {}` wedged the whole process: a worker on another socket stopped answering, and stayed dead after the client gave up. **[V]** §7.2
4. One tenant's memory hog killed the whole process. A V8 flag (`--max-old-space-size`) is process-wide, turns heap exhaustion into a process abort, and does not cover `ArrayBuffer` memory, which a cgroup limit still had to kill. **[V]** §7.3
5. Egress can be closed completely and left open to one broker. With `globalOutbound` set to a deny Worker, an empty `Network`, or an `ExternalServer` to the broker, no `fetch()` or `connect()` socket reached the internet, loopback, or link-local addresses, and the service binding to the broker kept working. **[V]** §7.1 Default config does not do this: with no `globalOutbound`, public internet and `connect()` sockets are open. **[V]**
6. A worker in workerd has no real filesystem, no inherited environment, and no `eval`/`new Function`, even with `nodejs_compat`. **[V]** §7.4
7. gVisor under k3s is two config edits: register a `runsc` runtime in containerd through k3s's `config-v3.toml.tmpl`, then add a `RuntimeClass` whose `handler` matches. k3s auto-detects a fixed list of runtimes and `runsc` is not on it. **[V]** [K1] [G2] [G3] I could not run `runsc` here, so the sandbox layer is documented, not tested. **[I]**
8. Kubernetes NetworkPolicy under k3s (embedded kube-router) can restrict runner egress to the broker, but cannot stop a pod reaching its own node, and does not log. **[V]** [K2] [K3] Treat it as a second wall behind workerd's `globalOutbound`, not the first.

## 1. What Cloudflare says about workerd as a sandbox

- The workerd README carries the heading "WARNING: `workerd` is not a hardened sandbox". It says workerd "tries to isolate each Worker so that it can only access the resources it is configured to access", but "on its own does not contain suitable defense-in-depth against the possibility of implementation bugs", and that "when using `workerd` to run possibly-malicious code, you must run it inside an appropriate secure sandbox", such as a virtual machine. **[V]** [W1]
- Cloudflare's own hosted service "uses many additional layers of defense-in-depth". The security-model page repeats it: "Local `workerd` processes do not include every defense-in-depth protection described here." **[V]** [W1] [C2]
- The layers Cloudflare lists for the hosted Workers runtime, and workerd does not ship: **[V]** [C1] [C2]
  - **Cordons.** Workers are grouped by trust level, so a Free-plan tenant is never scheduled in the same process as an Enterprise one. That bounds the damage of a V8 zero-day.
  - **A layer-2 sandbox** with Linux namespaces and seccomp, applied after the runtime loads, with an empty filesystem and no network except local Unix sockets to a supervisor and proxy.
  - **An outbound proxy** that blocks internal targets and tags each request with its originating Worker. Only HTTP leaves the sandbox.
  - **Process isolation for risky Workers.** Inspector-attached Workers, and Workers with suspicious performance metrics, are moved to their own process.
  - **A V8 patch gap under 24 hours**, by automated builds.
  - **Spectre mitigations**: frozen time during execution, no threads or shared memory, JS and Wasm only.
- V8 isolates share one process by design. Cloudflare's reason: a process per tenant would cost roughly 10x the CPU. **[V]** [C1] For Textile that means one V8 bug can cross tenants unless something outside the isolate stops it.
- Cloudflare also states what it has not solved: "no one has 'fixed' Spectre", and the mitigations "slow attacks rather than making them impossible". **[V]** [C1]
- Workers for Platforms, Cloudflare's product for running customer code, applies a few rules that carry over: each customer Worker runs in "untrusted mode" (own cache, no `request.cf`), a dynamic dispatch Worker enforces CPU and subrequest limits per customer, and an Outbound Worker intercepts every `fetch()` from user Workers for allow/block lists and credential injection. Turning on an Outbound Worker disables the `connect()` socket API for the customer Worker. **[V]** [C4] [C5]

## 2. Isolate limits (CPU, memory)

What workerd gives you, from source:

| Limit | Self-hosted workerd | Source |
| --- | --- | --- |
| CPU time per request | None. `NullLimitEnforcer::getLimitsExceeded()` returns `kj::none`; `enterJs()` returns nothing. The header comment: "workerd's local server doesn't enforce CPU time." | [W2] [W5] |
| Heap per isolate | None. `NullIsolateLimitEnforcer::getCreateParams()` returns `{}`; `hasExcessivelyExceededHeapLimit()` returns `false`. | [W2] |
| Subrequests per request | None. `newSubrequest()` is a no-op. | [W2] |
| Body buffering | `getBufferingLimit()` returns `kj::maxValue`. | [W2] |
| Config surface | `Worker` has no `limits`, `cpuMs`, or heap field. The only limit structs are `MemoryCacheLimits` and UDP idle/pending settings. | [W3] |
| Worker Loader (`workerLoader` binding) | `getEntrypointResolved(..., kj::Maybe<ResourceLimits> limits)` takes the limits and ignores them. | [W4] |
| `v8Flags` (config level) | Process-wide V8 flags, "Use at your own risk". | [W3] |

Cloudflare's hosted limits (CPU time 10 ms free, 30 s default and 5 min max paid; 128 MB per isolate; subrequest caps) are documented without reference to workerd. **[V]** [C6] The code above shows the open-source server does not enforce them, so the enforcer must live elsewhere in Cloudflare's stack. **[I]** I found no sign of an open-source one; absence in a snapshot is not proof.

Consequences, tested in §7.2 and §7.3:

- **CPU.** A tight JS loop never yields, so the event loop of the process stops. Nothing in workerd interrupts it. **[V]**
- **Memory.** `--max-old-space-size` bounds the JS heap but its failure mode is a process abort, and `ArrayBuffer` backing stores sit outside it. A cgroup is the only backstop, and it kills the process too. **[V]**
- **Blast radius is the process.** Every isolate in a workerd process dies or stalls together. Cloudflare's answer to the same problem is more processes (cordons, per-risky-Worker process), not tighter limits inside one. **[V]** [C1] [C2]

## 3. Network: blocking egress except a broker

From `workerd.capnp` **[V]** [W3]:

- Every Worker's global `fetch()` goes to `globalOutbound`, default `"internet"`. With no `internet` service defined, workerd defines one implicitly: `network = (allow = ["public"], tlsOptions = (trustBrowserCas = true))`.
- `Network` filters by CIDR or keyword (`public`, `private`, `local`, `network`, `unix`). A hostname is filtered **after** DNS: addresses that fail the rules are dropped, "as if the DNS entry did not exist". The default, public-only, exists "in order to prevent SSRF attacks".
- `globalOutbound` may be any service: a `Network`, a Worker, or an `ExternalServer`. A service binding with an `ExternalServer` delivers every `fetch()` to that server "regardless of whether the hostname or protocol specified in the URL actually match".
- `Worker.inherit` clones a worker with different bindings and `globalOutbound`; derived workers run in the same isolate as the base.

What the experiments added (§7.1) **[V]**:

| `globalOutbound` | internet | loopback | link-local (metadata) | `connect()` socket | broker service binding |
| --- | --- | --- | --- | --- | --- |
| unset (default) | allowed | blocked ("connecting to 127.0.0.1:18080 is not allowed") | blocked | **allowed** | works |
| Worker returning 403 | 403 | 403 | 403 | fails | works |
| `Network(allow = [])` | fails | fails | fails | fails | works |
| `ExternalServer` to the broker | delivered to broker | delivered to broker | delivered to broker | fails | works |

- Both a Worker service and an `ExternalServer` as `globalOutbound` close every path, including `connect()`.
- The `ExternalServer` is not subject to the `Network` filter (loopback broker reachable under it). That is the right shape for "reach only the bot host".
- A Worker-as-outbound sees the original URL (`req.url = https://api.example.org/v1/secret?x=1`). An `ExternalServer` as outbound sees the path and a `Host` header (`path=/v1/secret?x=1 host=api.example.org`) but not the scheme. §7.5
- The broker's own onward fetch to declared public hosts is a separate problem. If it runs through workerd's `Network(allow=["public"])` the DNS-then-filter order above already defeats a hostname that resolves to a private address at connect time. **[I]** If it runs through anything else, the PRD's DNS-rebinding test is the broker's job.

## 4. Pod sandbox: gVisor (`runsc`) on k3s

From the docs **[V]**:

- gVisor's Sentry reimplements the Linux system API so that "no system call is passed through directly to the host"; a Gofer process owns filesystem access; the host surface exposed to the Sentry is enumerated. [G1]
- It shrinks kernel attack surface only. gVisor says resource exhaustion and network policy "depend on host cgroups and container-level controls", and "a sandbox is not a substitute for a secure architecture". [G1]
- Requirements: x86_64 or ARM64, Linux 5.6+. Install `runsc` and `containerd-shim-runsc-v1` (the tarball contains both); `runsc` must be readable by all users because the Sentry may re-exec unprivileged. [G4]
- containerd registration: `runtimes.runsc` with `runtime_type = "io.containerd.runsc.v1"`; optional `options` with `TypeUrl = "io.containerd.runsc.v1.options"` and `ConfigPath = "/etc/containerd/runsc.toml"`, where `[runsc_config]` flags become `--flag=value`. [G2]
- Kubernetes: `RuntimeClass` with `handler: runsc` (matching the containerd runtime name), then `runtimeClassName: gvisor` on the pod. [G3]
- k3s: "automatically detect[s] alternative container runtimes if they are present when K3s starts", for a fixed list (`crun`, `nvidia`, `spin`, `wasmtime`, and others). `runsc` is not on it. For others, extend the base template in `/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl` (containerd 2.0) or `config.toml.tmpl` (containerd 1.7 and earlier) with `{{ template "base" . }}` and a runtime block; the plugin key for v3 is `plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.<name>`. Do not copy a rendered `config.toml`. [K1]
- Performance: CPU-bound work and memory access add no cost; syscall-heavy and network- or VFS-heavy services pay most. Use the Systrap platform; ptrace is slowest; KVM "runs poorly with nested virtualization". [G5]

Inferences **[I]**:

- Runner config for k3s is a `config-v3.toml.tmpl` block with `runtime_type = "io.containerd.runsc.v1"` under the name `runsc`, plus a `RuntimeClass` with `handler: runsc`. I composed that from [K1] and [G2]; a third-party walkthrough agrees but I did not test it. Check the plugin key against the rendered `config.toml` on a k3s node of the cluster's version.
- olympus nodes are VMs ("hydra-olympus-1/2" per the sibling #20 research). Systrap needs no virtualisation extensions, so it should work there; KVM would need nested virtualisation. I did not check the node kernel.
- A workerd runner is I/O-light per event (accept an event over a socket, run JS, call the broker). gVisor's network overhead lands on that path, but at friends-scale it is unlikely to matter. Measure before ruling it out.
- gVisor does not fix §2: a stalled or memory-hungry workerd inside gVisor still stalls or dies.

## 5. Network policy under k3s

From the docs **[V]**:

- k3s ships an embedded network policy controller built on kube-router's netpol library, enabled unless started with `--disable-network-policy`. [K2] (The sibling #20 research, branch `research/cnpg-olympus`, found it in use on olympus.)
- NetworkPolicy "has no effect" without a plugin that implements it. Pods are non-isolated until a policy selects them for that direction. Policies are additive allow-lists. A connection needs the source's egress and the destination's ingress to allow it. [K3]
- A default-deny egress policy "also blocks DNS traffic"; allow it separately if needed. [K3] A runner whose `ExternalServer` is an IP needs no DNS; one addressing the broker by Service name needs CoreDNS egress. **[I]**
- Limits that matter here [K3]:
  - "traffic to and from the node where a Pod is running is always allowed", and pods "cannot currently block localhost access, nor ... access from their resident node".
  - `hostNetwork` pods are usually treated like node traffic.
  - No policy event logging, no explicit deny.
  - ICMP and other non-TCP/UDP/SCTP behaviour is plugin-defined.
  - A pod created before the plugin finishes processing a policy "may be started unprotected".
  - Rewritten traffic (Service IPs, load balancers): "it is not defined" whether policy applies before or after NAT, so `ipBlock` rules can behave differently by plugin.
- Traffic to Service IPs is rewritten to pod IPs; whether the policy sees the Service IP or the pod IP is plugin-specific. Select the broker with `podSelector`/`namespaceSelector` rather than an `ipBlock` on a Service IP. **[I]**

The node-traffic exception is the one that bites: a runner pod can always reach its own node, so kubelet (10250), node-local services, and a cloud metadata address on the node's link-local route are outside the policy. Close them at the node firewall, not NetworkPolicy. **[I]** gVisor adds its own netstack between the app and the pod's veth, so the host sees runner traffic as ordinary pod traffic and the policy still applies. **[I]**

## 6. Recommendation: layers

Each layer assumes the one inside it can fail.

| # | Layer | Config | Protects against | Still exposed |
| --- | --- | --- | --- | --- |
| 1 | **Supervisor around workerd** (the Isolate host) | Trusted process starts workerd, sends one event at a time per workerd process, enforces a **wall-clock deadline** and kills the process on overrun; restarts it. Run **one workerd process per bot** (or a small fixed group), not one for all bots. | Runaway CPU and memory taking down other bots: with a process per bot, a spin or OOM only costs that bot. | The bot's own other workflows share its process. A V8 escape reaches only that bot's workers. Restart latency on every kill. |
| 2 | **Per-process cgroup limits** | Pod CPU/memory requests and limits per runner pod; pod-per-bot-group if one pod cannot hold limits per workerd process. CPU quota throttles; it does not stop a loop, so the supervisor deadline is the actual stop. | One bot starving the node of CPU or RAM; memory exhaustion beyond the heap (ArrayBuffers). | Throttled-but-alive loops until the deadline. A cgroup OOM kills the whole pod if several workerd processes share a cgroup limit. |
| 3 | **workerd config** | No secrets in bindings or env. `globalOutbound` = `ExternalServer` to the bot host's broker, so every `fetch()` lands there whatever the URL; no `connect()`. Only the broker service binding. No `DiskDirectory`, no `workerLoader`, no `workerdDebugPort`, no inspector. `compatibilityDate` pinned. Sockets bound to loopback or a pod-local Unix socket, reachable only by the supervisor. A `v8Flags` heap cap per process as an early abort. | Egress to anything but the broker, SSRF to private ranges and metadata, secret theft from env, filesystem access, `eval`. | Workerd or V8 bugs (§1); the broker itself; a malicious tenant can still call every grant it holds. |
| 4 | **Pod sandbox** | `runtimeClassName: gvisor` (Systrap) on the runner Deployment; non-root user, read-only root filesystem, `automountServiceAccountToken: false`, drop all capabilities, `seccompProfile: RuntimeDefault`, `hostNetwork: false`. | A V8 escape turning into arbitrary code and then a host kernel exploit. Narrows the escape to the Sentry's syscall surface. | Sentry bugs; side channels; CPU/memory exhaustion (a cgroup matter); pod-network reach. gVisor cannot cure a bad architecture. |
| 5 | **Network policy** | Runner pods: default-deny egress and ingress; egress only to the bot hosts' broker port (by pod selector); ingress only from the bot hosts or dispatcher. Separately, a node-firewall rule denying runner source ranges to node ports and the metadata address. | Pod-to-pod and pod-to-cluster-service movement if layers 3 and 4 fail (e.g. a workerd bug that opens a raw socket), including reaching Postgres and other tenants' pods. | The node itself (always allowed by NetworkPolicy); the broker port; no logging of blocked flows; startup race. |
| 6 | **Broker** (not a workerd setting) | Per-request grant check; resolve and filter destination IPs at connect time; declared hosts only; rate limits; the tenant's identity from the connection, not from request content. | A tenant using its grants beyond what was approved; DNS rebinding; confused-deputy calls for another bot. | Everything the grants allow. |

What stays exposed whatever you do: a V8 or workerd memory-corruption bug inside one process compromises that process, whose only reach is the broker (with its grants) and whatever layer 4 and 5 leave. Spectre-class cross-tenant reads within one process are not mitigated by workerd (Cloudflare's frozen-time and no-threads mitigations exist in the hosted runtime; this research did not check workerd). **[I]** Putting different bots in different processes is the mitigation, and also fixes §2.

## 7. Experiments

All files are under `~/scratch/workerd-hardening/` (not in this repo). `W=~/scratch/djs-workerd/node_modules/.bin/workerd` (`workerd 2026-10-31`). Configs use `compatibilityDate = "2026-10-01"` and a loopback HTTP socket; a Python `http.server` on `127.0.0.1:18080` stood in for a private/loopback target.

### 7.1 Egress variants

`probe.js` is a Worker that attempts `fetch("https://example.com/")`, `fetch("http://127.0.0.1:18080/")`, `fetch("http://169.254.169.254/")`, `connect({hostname:"example.com", port:443})` from `cloudflare:sockets`, and `env.BROKER.fetch("http://broker/ping")`. `broker.js` returns `broker saw /ping`.

Run per variant: `$W serve <variant>.capnp` then `curl http://127.0.0.1:<port>/`. Variants differ only in the `tenant` worker's `globalOutbound`:

- `a-default.capnp`: not set.
- `b-denyworker.capnp`: `globalOutbound = "deny"`, a Worker that returns 403.
- `c-nonet.capnp`: `globalOutbound = "nonet"`, `( name = "nonet", network = (allow = []) )`.
- `d-brokerext.capnp`: `globalOutbound = "brokerhost"`, `( name = "brokerhost", external = (address = "127.0.0.1:18080", http = ()) )`.

Results are in the table in §3. Raw output: a-default `{"internet":"status 200","loopback":"ERROR internal error…","metadata":"ERROR internal error…","socket":"socket opened","broker":"broker saw /ping"}`; the workerd log for it says `connecting to 127.0.0.1:18080 is not allowed` and `connecting to 169.254.169.254:80 is not allowed`.

### 7.2 Runaway CPU

`hog.js` serves `/spin` as `for (;;) {}`; `neighbor.js` returns `neighbor alive`. `hog.capnp` puts them on two services and two sockets (18090, 18091) in one workerd process.

1. `$W serve hog.capnp &`
2. `curl -m 8 http://127.0.0.1:18090/spin` — timed out, no response.
3. Start `/spin` again in the background; `curl -m 3 http://127.0.0.1:18091/` three times — every call timed out.
4. After the spin request's client timed out (about 20 s), the neighbor still timed out; `ps` showed workerd at about 95% CPU 34 s after start. Killed with `kill -9`.

### 7.3 Memory hog

`hog.js` also serves `/heap` (push objects with ~1 KB strings, up to 2e8 entries) and `/mem` (push 4096 × 1 MiB `Uint8Array`). `hog-v8flag.capnp` is `hog.capnp` plus top-level `v8Flags = ["--max-old-space-size=64"]`.

Each case ran as `systemd-run --user --scope -p MemoryMax=1G -p MemorySwapMax=0 $W serve <config>`, one request, then checked whether workerd was still up:

| Config | Request | Result |
| --- | --- | --- |
| `hog.capnp` | `/heap` | process gone, exit 137 (SIGKILL by cgroup) |
| `hog.capnp` | `/mem` | process gone, exit 137 |
| `hog-v8flag.capnp` | `/heap` | process gone, exit 1; log shows V8 "Last few GCs … 87.4 MB" then `Received signal #6: Aborted` |
| `hog-v8flag.capnp` | `/mem` | process gone, exit 137 (flag does not cover off-heap memory) |

### 7.4 Filesystem and environment

`fsprobe.js` under `compatibilityFlags = ["nodejs_compat"]`, with `SECRET_TEST=hunter2` set in workerd's environment: `fs.readFileSync("/etc/passwd")`, `fs.readdirSync("/home")`, `/proc/self/environ` all failed with "no such file or directory"; `Object.keys(process.env)` was empty; `new Function("return 1+1")` failed with "Code generation from strings disallowed for this context".

### 7.5 What the broker sees

`urlprobe.js` does `fetch("https://api.example.org/v1/secret?x=1")` with `globalOutbound = "out"`. `url-worker.capnp`: `out` is a Worker returning `req.url` and the Host header → `url=https://api.example.org/v1/secret?x=1 host=null`. `url-external.capnp`: `out` is an `ExternalServer` to a Python echo server → `path=/v1/secret?x=1 host=api.example.org`.

### Not run

`runsc` is not installed here and I did not touch a cluster, so gVisor behaviour, k3s RuntimeClass wiring, and NetworkPolicy enforcement are documented from sources only.

## Sources

Upstream workerd (`cloudflare/workerd` `main` at `eed7c37`, 2026-10-31):

- [W1] README, "WARNING: `workerd` is not a hardened sandbox": https://github.com/cloudflare/workerd/blob/main/README.md
- [W2] `src/workerd/server/factory/worker-factory.c++`, "Single-tenant policy: no limits", `NullIsolateLimitEnforcer`, `NullLimitEnforcer`: https://github.com/cloudflare/workerd/blob/main/src/workerd/server/factory/worker-factory.c%2B%2B
- [W3] `src/workerd/server/workerd.capnp`: `Config.v8Flags`, `Worker.globalOutbound`, `Worker.inherit`, `Network`, `ExternalServer`, `workerLoader`: https://github.com/cloudflare/workerd/blob/main/src/workerd/server/workerd.capnp
- [W4] `worker-factory.c++` `WorkerStubChannelHandle::getEntrypointResolved` (the `limits` parameter is unused): same file as [W2].
- [W5] `src/workerd/io/limit-enforcer.h`: https://github.com/cloudflare/workerd/blob/main/src/workerd/io/limit-enforcer.h

Cloudflare:

- [C1] Mitigating Spectre and other security threats: the Workers security model: https://blog.cloudflare.com/mitigating-spectre-and-other-security-threats-the-cloudflare-workers-security-model/
- [C2] Workers security model: https://developers.cloudflare.com/workers/reference/security-model/
- [C4] Workers for Platforms, how it works (untrusted mode, custom limits): https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/reference/how-workers-for-platforms-works/
- [C5] Workers for Platforms, Outbound Workers: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/
- [C6] Workers limits: https://developers.cloudflare.com/workers/platform/limits/

gVisor:

- [G1] Security model: https://gvisor.dev/docs/architecture_guide/security/
- [G2] containerd advanced configuration: https://gvisor.dev/docs/user_guide/containerd/configuration/
- [G3] containerd quick start (RuntimeClass): https://gvisor.dev/docs/user_guide/containerd/quick_start/
- [G4] Installation: https://gvisor.dev/docs/user_guide/install/
- [G5] Performance guide: https://gvisor.dev/docs/architecture_guide/performance/

k3s and Kubernetes:

- [K1] k3s advanced (containerd templates, alternative runtimes, RuntimeClass): https://docs.k3s.io/advanced
- [K2] k3s networking services (embedded network policy controller): https://docs.k3s.io/networking/networking-services
- [K3] Kubernetes NetworkPolicy: https://kubernetes.io/docs/concepts/services-networking/network-policies/
