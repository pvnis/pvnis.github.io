---
layout: post.njk
title: "Every tenant gets cluster-admin: multi-tenant Kubernetes with vCluster, and where it stops"
description: "What vCluster actually isolates when tenants share bare-metal GPU nodes, the holes we found by attacking it from inside a tenant, and the host-side controls that close them."
author: Dan Mihai Dumitriu
date: 2026-10-08
tags: [posts, Kubernetes, vCluster, gVisor, multi-tenancy]
draft: true
---

We run GPU machines that several teams have to share, from a single RTX 5070 on a desk up to an 8× B300 box. The people using them don't want a namespace. They want to install operators and CRDs, create their own namespaces and RBAC, and run `kubectl` as cluster-admin, without being able to see each other or the host. And underneath, they share a kernel, a node and, eventually, a GPU.

This post is about the first half of that: giving every tenant their own Kubernetes with [vCluster](https://www.vcluster.com/), what that buys, what it doesn't, and what we had to add on the host to make it hold against a tenant who is actively trying to get out. The second half, slicing one GPU between tenants inside gVisor's Sentry, is the next post. Everything here is in [`pvnis/vcluster-multitenant`](https://github.com/pvnis/vcluster-multitenant), with every result reproduced on k3s v1.36, vCluster 0.36.1 and Cilium 1.19.5.

<div class="stats">
  <div class="stat"><b>1</b><span>API server per tenant, each tenant cluster-admin of their own</span></div>
  <div class="stat"><b>~3 %</b><span>GPU throughput cost of the vCluster layer, two tenants on one card</span></div>
  <div class="stat"><b>10 / 10</b><span>network isolation tests passing, each deny held for 60 s</span></div>
  <div class="stat"><b>0</b><span>security controls that live inside the tenant's cluster</span></div>
</div>

That last number is the main lesson, and most of this post is about why it has to be zero.

## Three ways to share a cluster

Kubernetes multi-tenancy usually comes in one of three shapes.

<div class="table-wrap">

| | Namespace per tenant | Virtual cluster per tenant | Real cluster per tenant |
|---|---|---|---|
| Tenant's own API server | no | **yes** | yes |
| Tenant can install CRDs, operators, webhooks | no | **yes** | yes |
| Tenant is cluster-admin | no | **of the virtual cluster** | yes |
| Shares nodes and kernel | yes | yes (by default) | no |
| Cost per tenant | a namespace | one pod | a control plane and nodes |

</div>

Namespaces with RBAC (plus tools like Capsule or hierarchical namespaces) are cheap, but every tenant shares one set of cluster-scoped objects. Only one version of a CRD can exist, there is one set of admission webhooks, and nobody but the platform team gets to be admin. A cluster per tenant is the clean answer and the expensive one, and it doesn't help when the tenants need to share a machine, which is the whole point when the machine is a GPU server.

vCluster sits in between. Each tenant gets a real Kubernetes control plane, running as a pod in a namespace on the host cluster. The tenant can do anything to it. Their workloads still run on the host's nodes.

## How vCluster works

A virtual cluster is an API server, a controller manager and a backing store (in the open-source default, SQLite on a PVC via kine), all in one StatefulSet in the tenant's host namespace. The tenant gets a kubeconfig that points at that API server. Most objects the tenant creates, such as Deployments, ReplicaSets, ServiceAccounts, RBAC, CRDs and their instances, live only there.

Pods are different, because something has to run them. A component called the **syncer** watches the virtual cluster and copies the low-level objects (pods, services, endpoints, PVCs, ConfigMaps and Secrets that pods reference) down into the tenant's namespace on the host, where the real scheduler and kubelet run them. Names are rewritten so tenants can't collide: a pod `probe` in the tenant's namespace `team-alpha` becomes `probe-x-team-alpha-x-tenant-a` on the host. Status flows back up, so from inside, everything looks like an ordinary cluster.

<figure class="diagram">
<svg viewBox="0 0 720 360" role="img" aria-labelledby="vc-title">
  <title id="vc-title">Two tenant API servers, each in its own vCluster where the tenant is cluster-admin. The syncer copies pods, services and PVCs down into a per-tenant namespace on the host cluster. Each host namespace carries the controls that bind the tenant: Pod Security baseline, ResourceQuota, LimitRange, a forced gVisor runtime class, and a cluster-scoped Cilium deny floor. Underneath, one node, one kernel and one GPU are shared.</title>
  <defs><marker id="ah-vc" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="dg-arrow"/></marker></defs>
  <rect class="dg-zone" x="20" y="24" width="680" height="110" rx="8"/>
  <text class="dg-z" x="34" y="44">inside each vCluster · tenant is cluster-admin</text>
  <rect class="dg-box" x="40" y="58" width="300" height="60" rx="6"/>
  <text class="dg-t" x="190" y="82" text-anchor="middle">tenant-a API server</text>
  <text class="dg-s" x="190" y="102" text-anchor="middle">Deployments · CRDs · RBAC · Secrets</text>
  <rect class="dg-box" x="380" y="58" width="300" height="60" rx="6"/>
  <text class="dg-t" x="530" y="82" text-anchor="middle">tenant-b API server</text>
  <text class="dg-s" x="530" y="102" text-anchor="middle">Deployments · CRDs · RBAC · Secrets</text>
  <line class="dg-line" x1="190" y1="118" x2="190" y2="182" marker-end="url(#ah-vc)"/>
  <line class="dg-line" x1="530" y1="118" x2="530" y2="182" marker-end="url(#ah-vc)"/>
  <text class="dg-s" x="360" y="152" text-anchor="middle">syncer copies pods, services, PVCs</text>
  <text class="dg-s" x="360" y="168" text-anchor="middle">renamed &lt;pod&gt;-x-&lt;ns&gt;-x-&lt;vc&gt;</text>
  <rect class="dg-zone" x="20" y="186" width="680" height="134" rx="8"/>
  <text class="dg-z" x="34" y="206">host cluster · tenant has no credentials</text>
  <rect class="dg-box key" x="40" y="218" width="300" height="88" rx="6"/>
  <text class="dg-t" x="190" y="240" text-anchor="middle">namespace tenant-a</text>
  <text class="dg-s" x="190" y="260" text-anchor="middle">PSA baseline · ResourceQuota · LimitRange</text>
  <text class="dg-s" x="190" y="276" text-anchor="middle">runtimeClassName forced to gvisor</text>
  <text class="dg-s" x="190" y="292" text-anchor="middle">Cilium deny floor (cluster-scoped)</text>
  <rect class="dg-box key" x="380" y="218" width="300" height="88" rx="6"/>
  <text class="dg-t" x="530" y="240" text-anchor="middle">namespace tenant-b</text>
  <text class="dg-s" x="530" y="260" text-anchor="middle">PSA baseline · ResourceQuota · LimitRange</text>
  <text class="dg-s" x="530" y="276" text-anchor="middle">runtimeClassName forced to gvisor</text>
  <text class="dg-s" x="530" y="292" text-anchor="middle">Cilium deny floor (cluster-scoped)</text>
  <text class="dg-s" x="360" y="344" text-anchor="middle">one node · one kernel, each pod behind its own gVisor Sentry · one GPU</text>
</svg>
<figcaption>The tenant owns everything above the syncer. Everything that actually constrains them is below it, on the host, where they have no access.</figcaption>
</figure>

Standing up a tenant is short. The settings that matter are in a shared values file ([`values/tenant.yaml`](https://github.com/pvnis/vcluster-multitenant/blob/master/values/tenant.yaml), heavily commented), plus a one-line overlay per tenant that fixes its NodePort:

```bash
kubectl create namespace tenant-a
vcluster create tenant-a -n tenant-a \
  --values tenant.yaml --values tenant-a.yaml --connect=false
vcluster connect tenant-a -n tenant-a --print \
  --server=https://$NODEIP:30443 > kubeconfigs/tenant-a.yaml
```

That kubeconfig is a client certificate with cluster-admin on the virtual cluster. It's the only credential the tenant ever gets.

## What vCluster gives you

We verified each of these from inside a tenant, with the tenant's own kubeconfig.

**Separate control planes.** Tenant B can't see tenant A's namespaces, pods, CRDs or events. Their `kube-system` has only their own CoreDNS, not the host's schedulers or device plugins, and neither tenant can list the host's admission webhooks.

```console
$ KUBECONFIG=tenant-a.yaml kubectl create ns team-alpha
$ KUBECONFIG=tenant-a.yaml kubectl -n team-alpha run probe --image=busybox -- sleep 3600

$ KUBECONFIG=tenant-b.yaml kubectl get pods -A
NAMESPACE     NAME                      READY   STATUS    RESTARTS   AGE
kube-system   coredns-df8c87f55-qnrt7   1/1     Running   0          79s

$ kubectl get pods -A | grep probe          # on the host
tenant-a   probe-x-team-alpha-x-tenant-a   1/1   Running   0   8s
```

**Real admin rights, scoped.** Inside their cluster a tenant can do anything (`kubectl auth can-i '*' '*'` says yes). The service account token inside a tenant pod has the virtual cluster as its audience and points at the virtual API server, not the host's, and `get secrets -A` shows none of the host's.

**Fake nodes.** By default the tenant sees synthetic nodes carrying enough capacity to schedule, not the real node's name, labels, taints or image list. (There is a catch for GPUs, below.)

**Some identity the tenant can't forge.** The syncer stamps every host pod with `vcluster.loft.sh/managed-by=<tenant>`, and if a tenant tries to set that label themselves, at creation or later with `kubectl label --overwrite`, the syncer restores the true owner and moves the tenant's value to a hashed key that nothing references. Tenant service accounts aren't synced at all: every workload pod runs on the host as the one account `vc-workload-<tenant>`, whatever it asked for. Only the control plane runs as `vc-<tenant>`. These two facts turn out to be the anchors for network policy.

**Low overhead.** Two tenants sharing one GPU through vCluster got 315.9 and 314.1 kernel launches/s. The same two workloads as plain pods got about 324 each. The difference is control plane, not GPU path.

## What it doesn't

vCluster's own documentation is clear that the shared-nodes mode isolates the control plane, and that tenants share the kernel and the worker nodes. In practice that means vCluster decides *what a tenant can see*. It does not decide *what a tenant's pods can do* once they reach the host. Here is what we found when we attacked it from inside a tenant.

**The virtual API server will accept a host escape.** A pod spec with `privileged: true` and a `hostPath: /` volume passes the vCluster's own server-side admission. The tenant is admin of their cluster, so of course it does: there is no Pod Security enforcement inside the virtual cluster that the tenant couldn't remove. Before we added host-side policy, the syncer created that pod on the host, and the tenant read this:

```console
$ KUBECONFIG=tenant-a.yaml kubectl logs hostpath
k3s.yaml
root:!:20591:0:99999:7:::
```

That is the host cluster's admin kubeconfig and `/etc/shadow`. Total compromise, of the host and every other tenant. A sandboxed runtime doesn't help: gVisor sandboxes the kernel interface, it doesn't decide which host paths the runtime hands into the sandbox.

**The tenant picks their own runtime.** For a tenant to use `runtimeClassName: gvisor`, their API server has to know the RuntimeClass exists, so you sync RuntimeClasses from the host. That also shows the tenant every *other* handler, which on a GPU node includes ordinary runc ones:

```console
runtimeClassName=gvisor -> Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016
runtimeClassName=nvidia -> Linux version 6.8.0-117-generic ... #117~22.04.1-Ubuntu
```

One line of YAML and the tenant is on the host kernel with a GPU attached, outside every sandbox guarantee.

**Labels and annotations pass through verbatim.** Apart from `managed-by`, a pod's labels land on the host exactly as the tenant wrote them. Our first network design exempted the vCluster control plane by selecting `app NotIn [vcluster]`, and a tenant could label their pod `app=vcluster` and get the same treatment as their control plane. Annotations pass through too, which matters for anything on the host that is configured by annotation. In our stack that includes gVisor's per-pod GPU memory and compute limits, so a tenant could simply write themselves a bigger share.

**Tenant NetworkPolicies silently do nothing.** With the chart defaults, a tenant can create a NetworkPolicy, see it listed in their cluster, and it never reaches the host. A tenant who believes they've segmented their application and hasn't is worse off than one who knows they can't.

**Shared host resources leak through.** NodePort Services are synced and allocate from the host's single port range, so one tenant can take a port another wanted. Quotas you set inside a vCluster can be deleted by the tenant. And without a CNI policy, all tenants are on one flat pod network.

All of these come down to one sentence, which we put at the top of the repository's README: **a tenant is root in their own cluster, so any control they can see is a control they can delete.** Every control has to be applied on the host side of the syncer.

## Closing the gaps on the host

None of the fixes is exotic. What matters is that each lives somewhere the tenant can't reach.

<div class="table-wrap">

| Gap | Host-side control | Result |
|---|---|---|
| hostPath, privileged, host namespaces | Pod Security Admission `baseline` enforced on the tenant's host namespace (`restricted` in warn/audit) | refused at the sync boundary, reason visible in the tenant's own events |
| Tenant chooses runc | `sync.toHost.pods.runtimeClassName: gvisor`: the syncer overwrites the field on every host pod | `nvidia`, `crun`, `gvisor` all run under gVisor |
| Resource exhaustion | ResourceQuota (CPU, memory, GPU, pod and PVC counts) plus a LimitRange for defaults | an over-quota pod stays Pending with the quota error in its events |
| Self-raised GPU share | narrow-only mutating webhook restates the pod's GPU request as gVisor annotations, `failurePolicy: Fail` | a self-annotated 256 GiB / weight 100 was rewritten to the 20000 MiB / weight 20 it requested |
| Cross-tenant and outbound traffic | Cilium, three policy layers, deny floor keyed on unforgeable identity | 10 of 10 isolation tests pass, including against a tenant's allow-all policy |

</div>

Two of these are worth more detail.

**The runtime class has to be forced, not offered.** Syncing RuntimeClasses is necessary; trusting the tenant's choice is fatal. With the override set, the tenant can still write any `runtimeClassName`, for their own reasons, and it has no effect on what containerd runs:

```console
$ kubectl -n tenant-a get pods -o custom-columns='NAME:.metadata.name,RC:.spec.runtimeClassName'
rt2-crun-x-default-x-tenant-a     gvisor
rt2-gvisor-x-default-x-tenant-a   gvisor
rt2-nvidia-x-default-x-tenant-a   gvisor
```

A tenant also can't redefine what `gvisor` means: `handler` is immutable, a RuntimeClass the tenant creates is deleted again by the syncer within a second, and deleting `gvisor` to race in a runc version lost to the syncer too. And only the host's definition reaches containerd anyway.

**Network isolation needs a floor that tenants can't raise.** Kubernetes NetworkPolicy is additive-allow: if any policy permits a flow, it's permitted. So the moment you let tenants author policies (and you should, for the reason above), anything they write can only *widen* their access. There is no way to write a floor in NetworkPolicy alone. Cilium's deny rules take precedence over every allow, including a plain Kubernetes NetworkPolicy, and that gives us three layers ([full design](https://github.com/pvnis/vcluster-multitenant/blob/master/CILIUM-DESIGN.md)):

1. **The floor.** A `CiliumClusterwideNetworkPolicy` per tenant, with `ingressDeny` and `egressDeny` for every other tenant's endpoints and for everything off-cluster. Cluster-scoped objects live in no namespace, so vCluster can't sync it into the tenant and the tenant can't see or touch it.
2. **The allow-list.** A `CiliumNetworkPolicy` in the tenant's host namespace, managed by the platform: DNS, their own vCluster API, same-tenant pods.
3. **Self-service.** `sync.toHost.networkPolicies.enabled: true`, so the tenant's own NetworkPolicies reach the host and do something. They can segment their application; they can't get past layer 1.

The floor selects workload pods by `managed-by` and exempts the control plane by its service account, the two labels the syncer won't let a tenant forge. (The control plane needs the host API server, or the tenant's cluster dies.) We tested that directly with four attack pods claiming `app=vcluster`, overwriting `managed-by`, impersonating the other tenant and forging the control plane's service account, each probing the other tenant, the internet and the host API server. All twelve combinations were blocked. Then tenant A wrote the policy any hostile tenant would write:

```yaml
kind: NetworkPolicy
metadata: {name: tenant-tries-to-open-everything}
spec:
  podSelector: {}
  policyTypes: [Ingress, Egress]
  ingress: [{}]
  egress:  [{}]
```

It reached the host, which proves layer 3 works, and opened nothing:

```
  PASS tenant-a client -> tenant-b server (blocked for 45s, 9 attempts)
  PASS tenant-b client -> tenant-a server (blocked for 45s, 9 attempts)
  PASS tenant-a -> internet by IP (blocked for 45s, 9 attempts)
  PASS tenant-a workload -> host API server (blocked for 45s, 22 attempts)
```

<div class="callout">
<p class="callout-title">gVisor and Cilium: one setting</p>

Cilium's kube-proxy replacement translates ClusterIPs in an eBPF hook on the `connect()` syscall. A gVisor pod never makes that syscall on the host: the Sentry implements TCP in userspace and emits finished packets onto the veth. Without `socketLB.hostNamespaceOnly=true`, which makes Cilium fall back to translating at the veth, no sandboxed pod can reach a Service while everything else in the cluster looks healthy. It's the first test in our suite for that reason.
</div>

## Test like the tenant is lying to you

The most useful thing we learned on the network side wasn't about policy. It was that **a failed connection proves nothing.** A probe that fires as its pod starts hits a window, about two seconds under kube-router, before the policy engine knows the new pod, and fails in exactly the way a correctly blocked connection fails. That gave us two false "cross-tenant blocked" results before we caught it. A third came from `kubectl exec` against a restarting client pod, which fails identically to a refused connection if you only read kubectl's exit status.

On a deny test, all three fail in the dangerous direction: a probe that never ran scores as "blocked". So [`test-isolation.sh`](https://github.com/pvnis/vcluster-multitenant/blob/master/test-isolation.sh) runs every probe in a long-lived pod, decides the verdict *inside* the pod and echoes back a sentinel (no sentinel means the probe didn't run, so retry), retries "must succeed" probes until they work, and only believes a "must fail" probe after it has failed for a full minute. A deny test in which no probe ever ran is reported as inconclusive, never as a pass.

## What's still open

The setup above holds against everything we threw at it, but it doesn't close everything, and it's worth being explicit about what remains.

- **Pod Security is `baseline`, not `restricted`.** Tenants can still run as root and without a seccomp profile. gVisor makes that much less interesting than it would be under runc, but enforcing `restricted` (or a Kyverno or ValidatingAdmissionPolicy set tailored to the platform) is the obvious next step. The namespaces already warn and audit on `restricted`, so we can see what would break first.
- **The forgery results are behaviour, not contract.** That the syncer rewrites `managed-by` and the service account is how vCluster 0.36.1 behaves, not a documented guarantee, and the whole network floor rests on it. Every vCluster upgrade has to re-run the forgery probes before it's trusted.
- **Annotation-driven host config needs a gatekeeper.** Anything on the host configured by pod annotations is tenant-writable through the syncer. Our GPU limits are protected by a narrow-only webhook; any other annotation-driven component you add needs the same, or an explicit annotation allow-list.
- **GPU pods need real nodes.** Fake nodes have no GPU allocatable, so a GPU pod's scheduler inside the vCluster can't place it. GPU tenants get the real node synced, narrowed by a label selector to GPU nodes only. It works, but it gives back some of what fake nodes hid.
- **NodePorts are first come, first served.** Tenant NodePorts are hand-assigned today. A host-side admission policy forbidding `type: NodePort` in tenant namespaces, with an ingress or load balancer per tenant instead, would fix it.
- **Egress is CIDR-based.** Granting a tenant internet access means adding an exception to the deny floor. Cilium's `toFQDNs` would let us do it by name, and was a reason we chose Cilium.
- **Fair share is per pod, not per tenant.** The quota caps what each tenant can request, but nothing reserves headroom for host components, and the GPU compute scheduler divides by sandbox weight, so at equal weights two pods from one tenant get twice the GPU of one pod from another. Per-tenant weights are future work.
- **Operations.** Each tenant control plane is a single replica on SQLite on a node-local volume, so it can't move to another node; vCluster's embedded etcd needs the Pro tier. There is no per-tenant audit trail or metering yet; Hubble is running and unused, and is the natural place to start. Across nodes, tenant traffic will need encryption (WireGuard in Cilium).

And the shared-nodes model has a ceiling. Some tenants shouldn't share a kernel with anyone, whatever the sandbox. vCluster also offers dedicated and private nodes, where a tenant's pods land only on nodes reserved for them, all the way to nodes that join that tenant's virtual cluster alone with their own CNI. For a tenant renting a whole 8-GPU box, that is the right model. Ours are tenants who each want a slice of one.

## Next: slicing the GPU

So far each tenant has their own API server, can't reach the host or each other, and every pod they run is in a gVisor sandbox they can't opt out of. But the sandboxes share a GPU, and nothing in Kubernetes enforces how much of it each one gets. HAMi can place fractional GPU requests, but placement isn't enforcement, and its own limiter is a library loaded inside the container, which is the one place the tenant controls.

In our stack, the enforcement happens in gVisor's Sentry. Every GPU ioctl a sandboxed process makes goes through nvproxy, so the Sentry can refuse an allocation past the sandbox's memory limit and time-slice compute between sandboxes through a host scheduler. From inside a tenant, a pod capped at 512 MiB on a 12 GB card is refused past 320 MiB. Two pods weighted 75 and 25 on one B300 GPU, launched from inside a tenant, get 2.8 : 1 of its matmul throughput. And in the threat model, vCluster, HAMi and the webhook are only trusted placement; the Sentry is what a hostile tenant actually runs into. That's the next post.
