# CloudNativePG on the olympus cluster

Research for [#20](https://github.com/mia-cx/discord-mcp/issues/20), feeding the Storage decision in the Textile PRD ([#15](https://github.com/mia-cx/discord-mcp/issues/15)). Read-only: nothing here was checked against the live cluster. Cluster facts come from `mia-cx/yggdrasil-spec` at `origin/main` `54cb5bd` (2026-10-30) plus the unmerged `feat/tastebase-db` and `docs/longhorn-two-replicas` branches. Upstream facts come from the CloudNativePG v1.30.1 docs source and the Barman Cloud plugin v0.15.1 docs source.

**Marks.** **[V]** verified in a cited source. **[I]** inference: my reading, not stated by a source or checkable offline.

## Answer in brief

1. CNPG is already in use on olympus: four `Cluster`s (pelican, caelestis, open-wearables, immich) on `main`, a fifth (tastebase) on an unmerged branch. **[V]** The operator itself is not installed by GitOps: no Argo Application, chart, or `cnpg-system` reference exists anywhere in the repo. **[V]** It was probably applied by hand. **[I]**
2. Longhorn is also hand-installed. **[V]** The "degraded" volumes come from its stock StorageClass asking for 3 replicas on a 2-node cluster. **[V]** The fix is documented on an unmerged branch (`docs/longhorn-two-replicas`, dated 2026-10-25). **[V]**
3. Postgres needs no Longhorn replication of its own. CNPG's docs say to drop Longhorn to 1 replica per volume and let the instances replicate. **[V]** `longhorn-single` already exists for that. **[V]** It does not pin a volume to its pod's node, so add `dataLocality: strict-local`. **[I]**
4. Run Textile as its own 2-instance `Cluster`, the repo's pattern. **[V]** Two nodes cannot give three-way quorum, so failover is the only HA on offer: asynchronous replication, with a small loss window unless synchronous replication is switched on. **[V]**
5. Backups need an S3-compatible object store, and olympus has none. **[V]** The Barman Cloud plugin is the supported path; the in-tree object-store backup is deprecated. **[V]** The plugin needs cert-manager, which olympus has. **[V]**
6. Skip PgBouncer in v1. The Scheduler's advisory lock breaks under transaction pooling. **[V]** Add a `Pooler` later for the central tier only.
7. Credentials: one low-privilege role per tier through CNPG managed roles, runners get none, and a NetworkPolicy backs that up. **[I]**

## 1. What olympus shows

| Fact | Source |
| --- | --- |
| k3s VM(s) named `hydra-olympus-1/2`; nodes carry `workloads/*` labels. `workloads/critical` is the label every recent CNPG cluster selects (`Exists`). | [Y1] [Y2] [Y3] |
| Existing CNPG clusters: `pelican-database` (10Gi, `longhorn`), `caelestis-database` (10Gi, `longhorn`), `open-wearables-db` (10Gi, `longhorn`), `immich-database` (10Gi, default class). All `instances: 2`, `initdb` bootstrap, no `backup`, no `plugins`. | [Y4] |
| Unmerged: `tastebase-db`, 2 instances, 50Gi on `longhorn-single`, requests 250m/1Gi, limit 4Gi, a `LoadBalancer` service pinned by kube-vip. | [Y5] |
| `longhorn-single` StorageClass: `numberOfReplicas: "1"`, `volumeBindingMode: Immediate`, `reclaimPolicy: Delete`, no `dataLocality`. | [Y6] |
| Longhorn is installed with a hand-run `kubectl apply` of `longhorn.yaml` (main documents v1.6.0). The unmerged docs branch says v1.7.3 is running and that the stock StorageClass asks for 3 replicas, which two nodes can never satisfy. | [Y7] [Y8] |
| No GitOps entry for the CNPG operator, the Barman plugin, `ObjectStore`, `ScheduledBackup`, or `Backup`. Existing `Cluster` Applications add `ignoreDifferences` on `.spec.affinity` because the operator injects default anti-affinity and Argo sees drift. | [Y9] |
| No backup of any CNPG database. The Caelestis README: "CNPG replication and Longhorn replicas do not replace backups." No S3/R2/MinIO is deployed; MinIO appears only in a roadmap ("deploy MinIO in-cluster", a future use). | [Y10] [Y11] |
| Secrets are created by hand with `kubectl`, outside Git. No Sealed Secrets, External Secrets, or SOPS. CNPG's generated `<cluster>-app` Secret is consumed through `secretKeyRef` (open-wearables, immich, pelican). | [Y12] [Y4] |
| `discord-mcp` is Argo Application `discord-mcp` (path `argocd/discord-mcp`, `automated` with `prune` and `selfHeal`, `CreateNamespace=true`), one replica, `Recreate`, no data volumes. | [Y13] |
| NetworkPolicy enforcement exists: k3s's bundled kube-router netpol controller is in use, and several apps ship ingress policies. | [Y14] [Y15] |
| cert-manager runs on olympus (Argo Application plus a `cert-manager-config` app), which the Barman plugin requires. | [Y16] |
| Stale: `decisions.md` says "PostgreSQL: shared instance, per-service databases". Practice is one `Cluster` per app. | [Y17] |

## 2. Operator install

Upstream **[V]**:

- Current release is v1.30.1 (2026-09-23). It supports Kubernetes 1.34, 1.35, 1.36, so k3s v1.34.12 is inside the matrix. [C1] [C2]
- Install options are the static manifest (`kubectl apply --server-side`) or the Helm chart `cnpg/cloudnative-pg`, repo `https://cloudnative-pg.github.io/charts`, into `cnpg-system`. Chart 0.29.1 ships operator 1.30.1; the chart "supports only the latest point release". [C1] [C3]
- The two methods name the Deployment differently: `cnpg-controller-manager` (manifest) versus `cnpg-cloudnative-pg` (Helm). [C1]
- Upgrading the operator rolls every `Cluster` and ends each in a switchover; the default `primaryUpdateStrategy: unsupervised` does it unattended. [C1]
- Argo CD offers `ServerSideApply=true` for resources "too big to fit in 262144 bytes". [A1] CNPG's own install command uses `--server-side` for the same reason. **[I]**

Proposal **[I]**:

1. Add `argocd/_apps/cnpg.yaml`: Helm source `cloudnative-pg` at a pinned `0.29.1`, `releaseName: cnpg`, namespace `cnpg-system`, `syncOptions: [CreateNamespace=true, ServerSideApply=true]`, values from `argocd/cnpg/values.yaml` through the repo's multi-source `$values` pattern (as in `honeybot`, `immich`, `netbird-operator`).
2. Before the first sync, find out how the operator runs today (`kubectl get deploy -A | grep cnpg`) and its version. If a manifest-installed `cnpg-controller-manager` exists, adopting the chart creates a second `cnpg-cloudnative-pg` Deployment. Two operators fight over the same clusters. Delete the old Deployment in the same maintenance window, keeping the CRDs. Argo renders charts with `helm template`, so no Helm ownership conflict is expected on adopted objects.
3. Syncing a newer operator rolls all existing clusters (switchover each). Do it deliberately, not as a side effect of this work.
4. Pin the chart version; bump it by PR, like the other Applications.

## 3. Storage on a degraded, two-node Longhorn

Upstream **[V]**:

- CNPG's guidance for Longhorn and Ceph: drop volume replicas to **1**, because the instances already replicate; extra storage replicas only add write amplification. It also warns against one storage host holding blocks of different instances of the same cluster. Longhorn's `dataLocality: strict-local` plus pod anti-affinity achieves that. [C4]
- Longhorn `strict-local` keeps the single replica on the node where the volume is attached and is incompatible with RWX. [L1] The docs page does not describe node-loss behaviour, so the failure path (below) is **[I]**.
- CNPG defaults to *preferred* pod anti-affinity (`enablePodAntiAffinity: true`, `podAntiAffinityType: preferred`). [C5]
- CNPG recommends three nodes for a three-instance cluster; with two zones/nodes there is no quorum site. [C6]

Reading for olympus:

- A 1-replica volume cannot be "degraded" by replica count the way the 3-replica default volumes are **[I]**. That removes the failure Mia is seeing for Textile's volumes, without touching the shared Longhorn problem.
- `longhorn-single` uses `Immediate` binding and no locality. Longhorn may place both instances' single replicas on one node, which recreates the shared-storage single point of failure CNPG warns about. **[I]**
- Under `strict-local`, losing a node loses that instance's volume. CNPG recreates the instance from the surviving primary onto the returning or replacement node. **[I]** With two nodes, one node down means one instance, no standby, until it returns.

Proposal **[I]**: a dedicated class in `argocd/k3s/`:

```yaml
apiVersion: storage.k8s.io/v1
kind: StorageClass
metadata:
  name: longhorn-pg
provisioner: driver.longhorn.io
allowVolumeExpansion: true
reclaimPolicy: Retain        # a pruned Cluster must not take its volumes with it
volumeBindingMode: WaitForFirstConsumer
parameters:
  numberOfReplicas: "1"
  dataLocality: strict-local
  staleReplicaTimeout: "30"
  fsType: ext4
```

Retain and WaitForFirstConsumer are my additions, not CNPG requirements. Verify both against the running Longhorn version (v1.7.3 per the docs branch) before relying on them.

## 4. Cluster spec outline

Textile's data is small: encrypted tokens, shard resume state, workflow revisions, KV, schedules, audit log **[V per PRD]**. Sizes below are guesses **[I]**; resume state writes are the hot path.

```yaml
apiVersion: postgresql.cnpg.io/v1
kind: Cluster
metadata:
  name: textile-db                      # see open question 1
  namespace: discord-mcp                # see open question 1
  annotations:
    argocd.argoproj.io/sync-wave: "-1"
    argocd.argoproj.io/sync-options: Prune=false,Delete=false   # [A1]
spec:
  imageName: ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie   # same as pelican/caelestis; [Y4]
  instances: 2
  affinity:
    nodeAffinity:   # copy open-wearables: workloads/critical Exists   [Y4]
      ...
    podAntiAffinityType: required       # one instance per node
  storage:
    size: 10Gi
    storageClass: longhorn-pg
    resizeInUseVolumes: true
  resources:
    requests: { cpu: 250m, memory: 512Mi }
    limits:   { memory: 1Gi }
  bootstrap:
    initdb: { database: textile, owner: textile }
  plugins:
    - name: barman-cloud.cloudnative-pg.io
      isWALArchiver: true
      parameters: { barmanObjectName: textile-backups }
  managed:
    roles: [ ... see section 7 ... ]
```

Notes:

- **Instances: 2.** Matches every other olympus cluster **[V]** and the node count **[V]**. A third instance would share a node under *preferred* anti-affinity and would hang `Pending` under *required*. **[I]**
- **Replication is asynchronous by default.** Synchronous replication is off unless `postgresql.synchronous` is set, and the default behaviour of a required standby is to **pause writes** when it is unavailable. [C7] A middle path: `synchronous: {method: any, number: 1, dataDurability: preferred}` keeps RPO near zero while both nodes are up and falls back to async when one is down. **[I]** The PRD's resume state tolerates a small loss (stale sequence number means replay or a fresh identify) **[I]**, but stored tokens and workflow revisions should not be lost on failover. Open question 3.
- Copy the Argo `ignoreDifferences` on `.spec.affinity` into the `discord-mcp` Application. [Y9] The Prune/Delete guard keeps `automated.prune` from deleting the cluster. [A1]
- Do not set `managed.services.additional` (the tastebase LAN `LoadBalancer`). Textile's tiers all run in-cluster.

## 5. Backups and point-in-time recovery

Upstream **[V]**:

- Since 1.26, native backup is being phased out of the operator. The in-tree `barmanObjectStore` is deprecated; the supported path is the Barman Cloud plugin. Volume snapshots are the other option. [C8]
- Object-store backups always need WAL archiving, are hot only, and support retention policies. CNPG documents RPO ≤ 5 minutes with WAL archiving. [C8]
- PITR needs a WAL archive and a base backup. Recovery is **never in place**: it bootstraps a **new** `Cluster` with `bootstrap.recovery` and a `recoveryTarget` (`targetTime`, `targetLSN`, …). [C9]
- Plugin v0.15.1 (chart 0.8.1) requires CNPG ≥ 1.26 (≥ 1.27 recommended) and cert-manager, installs into the operator's namespace, and is available as a manifest or as chart `plugin-barman-cloud` from the CNPG chart repo. [B1] [B2]
- Tested object stores: S3, GCS, Azure Blob; RustFS and others tested. Any S3-compatible service works through `endpointURL`; the docs show Linode and DigitalOcean. Cloudflare R2 and Backblaze B2 are not mentioned. [B1] [B3]
- An `ObjectStore` is namespaced and used by `Cluster`s in that namespace; one store per cluster is recommended. Retention is `spec.retentionPolicy: "30d"` on the `ObjectStore`, a recovery window. [B4] [B5]
- `ScheduledBackup` uses six-field cron (with seconds), `method: plugin`, `immediate: true` for a first backup; default target is `prefer-standby`. [C8] [B4]
- Restoring needs an explicit `plugins` entry in the new cluster to keep archiving. [B6]

Backup target candidates already in the homelab:

| Candidate | State | Fit |
| --- | --- | --- |
| Cloudflare R2 | Cloudflare account and tokens exist (DDNS, cert-manager DNS-01). R2 is named in Mia's technology preferences, not deployed. **[V]** | Off-site and managed; S3 API through `endpointURL`. Not in the plugin's tested list. **[V]** Whether it works end-to-end is untested. **[I]** |
| MinIO or RustFS in the cluster, backed by the Storage LXC NFS (`10.0.1.2:/mnt/nvme`, `/mnt/media`) | MinIO is roadmap only. **[V]** NFS PVs exist. **[V]** | RustFS is in the plugin's tested list. **[V]** On the same Proxmox host as the cluster, so it does not survive host loss. **[I]** |
| Storage LXC NFS directly | NFS exports only. **[V]** | Barman Cloud speaks S3/Azure/GCS APIs, not filesystems. **[V]** Needs an S3 gateway on top. |
| Longhorn backup target / CSI snapshots | No backup target configured anywhere in the repo. **[V]** | Volume snapshots need the CSI snapshot controller, which k3s does not ship **[I]**; and `strict-local` volumes make it moot. Not recommended. |

Recommendation **[I]**: R2 for off-site WAL and base backups, with a daily `ScheduledBackup` and 30 days of retention. Add a restore drill to the checklist: bootstrap a throwaway cluster with `targetTime` into a scratch namespace before trusting it. Textile's encrypted token column plus a key held in a separate Secret means a backup leak does not leak tokens, but **losing the vault key makes every stored token unrecoverable**; back that key up outside the cluster.

## 6. Pooling

Upstream **[V]**:

- CNPG ships PgBouncer as a `Pooler` CRD, in the same namespace as the cluster, with `type: rw` or `ro`, default `poolMode: session`, and TLS plus a managed `cnpg_pooler_pgbouncer` auth user created automatically. A `Pooler`'s name cannot match its cluster. Poolers are independent of the cluster's lifecycle and roll with operator upgrades. [C10]
- PgBouncer transaction pooling never supports session-level advisory locks, `LISTEN`, `SET`, or `PREPARE`/`DEALLOCATE`. Protocol-level prepared statements need `max_prepared_statements` set non-zero. [P1]
- Drizzle's guidance for transaction-mode poolers (documented for Supabase, postgres-js driver): `prepare: false`. [D1]

Implication: the PRD's **Scheduler "fires cron triggers once across hosts, using a Postgres advisory lock"**. That lock must be taken on a direct connection to `<cluster>-rw` (or in session mode, or as a transaction-scoped lock). **[I]**

Proposal **[I]**: no `Pooler` in v1. Textile has a few central replicas and a handful of bot hosts, so connection counts are far below Postgres's default limits. If the central tier scales out, add a `Pooler` in `transaction` mode for central only, with `prepare: false` in its Drizzle client. Bot hosts and the Scheduler keep direct `-rw` connections.

## 7. Credentials per tier

Upstream **[V]**:

- CNPG creates `<cluster>-app` (type `kubernetes.io/basic-auth`) for the database owner: username, password, host, port, dbname, `uri`, `jdbc-uri`, `.pgpass`. It also creates `<cluster>-superuser` only if enabled. Network superuser access is off by default. [C11]
- Additional roles come from `managed.roles` (inline) or the new `DatabaseRole` resource (recommended in 1.30). Passwords come from a `kubernetes.io/basic-auth` Secret labelled `cnpg.io/reload: "true"`. Managed roles do not generate their own passwords. [C12]
- `kubectl cnpg certificate` can issue TLS client certs (default 90 days) for `cert` authentication. [C13]

Tiers, from the PRD: **central** holds no tokens and no Discord state; **bot hosts** are trusted and hold decrypted tokens; **runners** are untrusted and "reach nothing but their bot host's broker".

Proposal **[I]**:

| Tier | Postgres access | How |
| --- | --- | --- |
| Runners | **None.** | No Secret mounted; NetworkPolicy denies egress to the DB pods. |
| Central | Role `textile_central`: workflow revisions, grants, audit insert; **no** access to the token vault or resume tables. | Managed role plus `GRANT`s in migrations; password Secret created with `kubectl`, outside Git (repo convention). |
| Bot hosts | Role `textile_host`: token vault, resume state, KV, schedules, audit insert, workflow read. | Same mechanism; the StatefulSet mounts it via `secretKeyRef`. |
| Migrations | Owner role `textile` (the generated `textile-db-app`). | A Job, or the first bot host, runs Drizzle migrations; hosts and central never hold owner credentials. |

- Put the vault tables in their own schema (`vault`) so grants are legible; token encryption stays in the application (Token vault), so a DB role leak is not a token leak.
- Pick **passwords via managed roles** over TLS client certs: no 90-day renewal to wire into Drizzle clients, and it matches how the repo already consumes `-app` Secrets.
- NetworkPolicy on the DB pods: ingress on 5432 only from pods labelled as central and bot-host, plus the operator (`cnpg-system`) on its status port. The precedent is `open-wearables/networkpolicy.yaml`. [Y15]

## Open infrastructure questions for Mia

1. **Namespace and name.** `discord-mcp` today; the Textile rename is a separate issue. A `Cluster` cannot change namespace, and renaming means a restore. Create `textile-db` in `discord-mcp` now, or wait for the rename?
2. **Is the CNPG operator running now, and which version and install method?** Needs `kubectl get deploy -A | grep -i cnpg`. This decides whether section 2 is an adoption or a fresh install.
3. **Durability target.** Accept async failover (seconds of loss window) or turn on `synchronous` with `dataDurability: preferred`? Either way a node outage leaves a single instance.
4. **Backup destination.** R2 (needs a bucket and a scoped token), a self-hosted RustFS or MinIO on the Storage LXC, or both? Who holds the backup credentials?
5. **Longhorn.** Is the 2-replica ConfigMap fix from `docs/longhorn-two-replicas` applied? Is v1.7.3 really running? May we add `longhorn-pg` (`strict-local`, `Retain`) to `argocd/k3s/`?
6. **Node capacity.** RAM and disk per olympus node (the docs describe one 16 GB VM; there are now two nodes). Five CNPG clusters means up to ten Postgres pods once tastebase lands.
7. **Barman plugin and cert-manager.** OK to install the plugin chart next to the operator? The operator-to-plugin TLS uses cert-manager's self-signed issuance.
8. **Vault key custody.** Where does the off-cluster copy of the Token-vault key live (Vaultwarden is on the cluster)?

## Sources

**Yggdrasil-spec** (`origin/main` = `54cb5bd`, read with `git show`)

- [Y1] `apps/docs/content/infrastructure/kubernetes.md` (nodes, Longhorn install)
- [Y2] `apps/docs/content/infrastructure/workload-placement.md` (`workloads/*` labels)
- [Y3] `argocd/netbird-operator/README.md` (`hydra-olympus-1/2`)
- [Y4] `argocd/{pelican,caelestis,open-wearables,immich}/postgresql.yaml`; `argocd/open-wearables/backend.yaml`, `argocd/immich/values.yaml` (`-app` Secret use)
- [Y5] `argocd/tastebase/postgresql.yaml`, `README.md`, `argocd/_apps/tastebase.yaml` (branch `origin/feat/tastebase-db`, `39566ca`)
- [Y6] `argocd/k3s/longhorn-single-storageclass.yaml`
- [Y7] `apps/docs/content/infrastructure/kubernetes.md` on `origin/docs/longhorn-two-replicas` (`c947761`, 2026-10-25)
- [Y8] Issue [yggdrasil-spec#85](https://github.com/mia-cx/yggdrasil-spec/issues/85)
- [Y9] `argocd/_apps/{pelican,tastebase}.yaml`; `git grep` for `cloudnative-pg|cnpg-system|barman|ObjectStore` over `origin/main` and `origin/feat/tastebase-db`
- [Y10] `argocd/caelestis/README.md`
- [Y11] `apps/docs/content/roadmaps/services/self-hosted.md` (MinIO); `apps/docs/content/infrastructure/storage.md`; `argocd/k3s/nfs-pvs.yaml`
- [Y12] `argocd/discord-mcp/README.md`, `argocd/open-wearables/README.md`, `apps/docs/content/services/vaultwarden.md`
- [Y13] `argocd/_apps/discord-mcp.yaml`, `argocd/discord-mcp/deployment.yaml`
- [Y14] `AGENTS.md` (k3s kube-router netpol)
- [Y15] `argocd/open-wearables/networkpolicy.yaml`, `argocd/canary/networkpolicy.yaml`
- [Y16] `argocd/_apps/cert-manager.yaml`, `argocd/_apps/infrastructure.yaml`
- [Y17] `apps/docs/content/architecture/decisions.md`

**CloudNativePG v1.30.1** (`https://github.com/cloudnative-pg/cloudnative-pg/blob/v1.30.1/docs/src/`)

- [C1] `installation_upgrade.md`
- [C2] `supported_releases.md`
- [C3] Chart: <https://github.com/cloudnative-pg/charts/blob/main/charts/cloudnative-pg/README.md> and `Chart.yaml` (0.29.1 / 1.30.1)
- [C4] `storage.md#block-storage-considerations-ceph-longhorn`
- [C5] `scheduling.md`
- [C6] `architecture.md`
- [C7] `replication.md#synchronous-replication`
- [C8] `backup.md`
- [C9] `recovery.md`
- [C10] `connection_pooling.md`
- [C11] `applications.md#secrets`
- [C12] `declarative_role_management.md`
- [C13] `ssl_connections.md`

**Barman Cloud plugin v0.15.1** (`https://github.com/cloudnative-pg/plugin-barman-cloud/blob/v0.15.1/web/docs/`; chart `plugin-barman-cloud` 0.8.1)

- [B1] `intro.md`
- [B2] `installation.mdx`
- [B3] `object_stores.md`
- [B4] `concepts.md`
- [B5] `retention.md`
- [B6] `usage.md`

**Other**

- [L1] Longhorn 1.7.3 data locality: <https://longhorn.io/docs/1.7.3/high-availability/data-locality/>
- [P1] PgBouncer SQL feature map: <https://www.pgbouncer.org/features.html>
- [D1] Drizzle with Supabase transaction mode (`prepare: false`): <https://orm.drizzle.team/docs/connect-supabase>
- [A1] Argo CD sync options (Server-Side Apply, `Prune=false`, `Delete=false`): <https://argo-cd.readthedocs.io/en/stable/user-guide/sync-options/>
