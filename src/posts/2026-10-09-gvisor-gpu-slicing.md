---
layout: post.njk
title: "Slicing a GPU between tenants who don't trust each other"
description: "How we divide one NVIDIA or AMD GPU's memory and compute between gVisor sandboxes, with every limit enforced somewhere the workload can't reach: what worked, what we got wrong, and what it costs."
author: Dan Mihai Dumitriu
date: 2026-10-09
tags: [posts, gVisor, GPU, Kubernetes, multi-tenancy]
draft: true
---

The [previous post](/blog/vcluster-multitenancy/) gave every tenant their own Kubernetes API server with vCluster, cut them off from the host and from each other, and forced every pod they run into a gVisor sandbox. It ended with the problem it couldn't solve: those sandboxes share a GPU, and nothing in Kubernetes decides how much of it each one gets.

This post is about that GPU. Over the last two months we changed gVisor so that one NVIDIA or AMD GPU can be divided between mutually untrusting sandboxes, in memory and in compute, with every limit enforced outside the container. The work is on the [`gpuslicing`](https://github.com/pvnis/gvisor/tree/gpuslicing) branch of our gVisor fork, with a small driver extension on the same branch of our [open GPU kernel modules](https://github.com/pvnis/open-gpu-kernel-modules/tree/gpuslicing) fork, and it runs today from a single RTX 5070 up to an 8× B300 box.

<div class="stats">
  <div class="stat"><b>0</b><span>ioctls during 13,000 CUDA kernel launches: why compute is hard</span></div>
  <div class="stat"><b>3.10 : 1</b><span>cuBLAS split for a 3 : 1 request, automatic and work-conserving</span></div>
  <div class="stat"><b>−0.61 %</b><span>change in an AMD tenant's rate when a neighbour starts on the other CUs</span></div>
  <div class="stat"><b>696 GB/s</b><span>8-GPU NCCL all-reduce bus bandwidth, inside a gVisor sandbox on a B300</span></div>
</div>

It took longer than it should have, partly because the GPU makes compute isolation genuinely hard and partly because we confidently wrote down a wrong conclusion about the hardware for several days. Both are in here.

## The rule: nothing inside the container

Everything below follows from one constraint: **no limit may depend on anything inside the container.** On a shared GPU the workload is the adversary. A limit it can reach is a limit it can lift.

That rules out most of what exists today.

<div class="table-wrap">

| | What it gives | Why it doesn't fit |
|---|---|---|
| MIG | real hardware partitions of memory and SMs | datacenter parts only, a few fixed sizes, drain the GPU to change them |
| MPS | concurrent kernels from several processes | not a security boundary; the client sets its own limits through environment variables |
| Device-plugin time-slicing | one GPU advertised as N | no memory limits, no shares; every replica thinks it has the whole card |
| HAMi | good placement, plus a limiter preloaded into the container | the limiter lives in the process it limits |

</div>

HAMi is the interesting case, because half of it is exactly right. Its scheduler understands requests like `nvidia.com/gpumem` and `nvidia.com/gpucores` and places pods so they fit. The enforcement is `libvgpu.so`, preloaded into the container to intercept the CUDA API, and the library honours an environment variable, `CUDA_DISABLE_CONTROL`, that switches it off. We measured it: a pod capped at 512 MiB was refused at 512 MiB, and with that one variable set it allocated 768 MiB against the whole 12 GB card.

So we kept HAMi for placement and moved the enforcement somewhere the workload can't get to.

## Where gVisor fits

gVisor runs a container against a userspace kernel, the **Sentry**, instead of the host kernel. Every syscall the application makes is handled by the Sentry, and for GPUs that includes the ioctls on `/dev/nvidia*` and `/dev/kfd`. Upstream gVisor already proxies these (`nvproxy` for NVIDIA, `amdproxy` for AMD), checking each call against an allowlist of structures it understands before forwarding it to the host driver. That is a real boundary, but it's about the *shape* of each call, not *quantity*. Nothing in it stops a container from taking all of the GPU's memory or keeping its SMs busy forever.

The Sentry is the natural place for quantity too: it sees every allocation, runs in a separate process the container can't touch, and needs nothing from the application. Most of this project is about finding out how much of the GPU can be controlled from there, and what to do about the part that can't.

<figure class="diagram">
<svg viewBox="0 0 720 400" role="img" aria-labelledby="gs-title">
  <title id="gs-title">A CUDA or ROCm application inside a gVisor sandbox makes ioctls that the Sentry checks and accounts before forwarding them to the host kernel driver. A host process, runsc gpu-scheduler, sends scheduling windows to each Sentry and, for NVIDIA, runlist timeslices to the driver. Work submission itself is a doorbell write from the application straight to the GPU that never passes through the Sentry.</title>
  <defs><marker id="ah-gs" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="dg-arrow"/></marker></defs>
  <rect class="dg-zone" x="50" y="20" width="310" height="212" rx="8"/>
  <text class="dg-z" x="60" y="40">gvisor sandbox · tenant pod</text>
  <rect class="dg-box" x="60" y="52" width="280" height="46" rx="6"/>
  <text class="dg-t" x="200" y="72" text-anchor="middle">CUDA / ROCm application</text>
  <text class="dg-s" x="200" y="90" text-anchor="middle">unmodified · nothing preloaded</text>
  <line class="dg-line" x1="200" y1="98" x2="200" y2="150" marker-end="url(#ah-gs)"/>
  <text class="dg-s" x="210" y="128">ioctls</text>
  <rect class="dg-box key" x="60" y="152" width="280" height="66" rx="6"/>
  <text class="dg-t" x="200" y="172" text-anchor="middle">Sentry: nvproxy / amdproxy</text>
  <text class="dg-s" x="200" y="190" text-anchor="middle">memory quota, admitted before forwarding</text>
  <text class="dg-s" x="200" y="206" text-anchor="middle">reported sizes clamped to the quota</text>
  <polyline class="dg-line" points="60,75 40,75 40,340" style="stroke-dasharray:5 4" marker-end="url(#ah-gs)"/>
  <text class="dg-s" transform="translate(30,215) rotate(-90)" text-anchor="middle">doorbell write · never a syscall</text>
  <rect class="dg-box key" x="420" y="52" width="280" height="60" rx="6"/>
  <text class="dg-t" x="560" y="76" text-anchor="middle">runsc gpu-scheduler (host)</text>
  <text class="dg-s" x="560" y="96" text-anchor="middle">weights → one schedule per GPU</text>
  <polyline class="dg-line" points="460,112 460,185 342,185" marker-end="url(#ah-gs)"/>
  <text class="dg-s" x="400" y="178" text-anchor="middle">windows</text>
  <line class="dg-line" x1="200" y1="218" x2="200" y2="260" marker-end="url(#ah-gs)"/>
  <text class="dg-s" x="210" y="244">forwarded after checks</text>
  <line class="dg-line" x1="620" y1="112" x2="620" y2="260" marker-end="url(#ah-gs)"/>
  <text class="dg-s" x="612" y="232" text-anchor="end">NVIDIA runlist timeslices</text>
  <rect class="dg-box" x="60" y="262" width="640" height="52" rx="6"/>
  <text class="dg-t" x="380" y="284" text-anchor="middle">host kernel driver</text>
  <text class="dg-s" x="380" y="302" text-anchor="middle">NVIDIA: open modules + broker hooks · AMD: stock amdgpu / KFD</text>
  <line class="dg-line" x1="200" y1="314" x2="200" y2="340" marker-end="url(#ah-gs)"/>
  <rect class="dg-box" x="20" y="342" width="680" height="40" rx="6"/>
  <text class="dg-t" x="360" y="367" text-anchor="middle">GPU · runlist scheduler · SMs / CUs · VRAM</text>
</svg>
<figcaption>Memory goes through the Sentry. Compute submission doesn't: once a channel is set up, the application writes commands to mapped memory and rings a doorbell, and no syscall is involved. That dashed line is the whole difficulty.</figcaption>
</figure>

## Memory: the tractable half

GPU memory is allocated through ioctls, and the Sentry sees all of them. So memory quotas are conceptually simple: count every allocation, and refuse the one that would cross the limit.

The details are where it gets real. The charge is taken **before** the ioctl is forwarded, so two concurrent allocations can't both slip in under the same headroom, and returned if the driver refuses. Charges are reference counted, because duplicating a handle aliases memory rather than allocating more, and released from the cascade that frees an object's dependents, the only place that sees all of them. Device memory and CUDA unified-memory address space are counted together, since unified memory is committed into device memory. Unified memory is charged when address space is reserved, not when pages are populated: the population happens inside the host's `nvidia-uvm` module, invisible to the Sentry, so reservation is the tightest bound it can enforce. Every allocation class in the allowlist has to make an explicit accounting decision, or a test fails.

The Sentry also makes the limit *visible*. It rewrites the sizes the driver reports, so `cuMemGetInfo()` (or `torch.cuda.mem_get_info()`, on either vendor) returns the sandbox's quota, not the card's size. That matters more than it sounds: frameworks size their memory pools from that call, so an unmodified PyTorch job behaves sensibly against a quota instead of confidently allocating past it. On a 12 GB RTX 5070, a pod capped at 512 MiB sees this:

```
device: NVIDIA GeForce RTX 5070
meminfo: free=350 MiB total=512 MiB
alloc 0..4: 64 MiB each
alloc 5 of 64 MiB: FAILED rc=2 (CUDA_ERROR_OUT_OF_MEMORY)
```

(The CUDA context itself takes the rest.) Over-limit allocations fail with the same error a genuinely full GPU gives, so applications handle them the way they already do. In red-team runs, a four-process barrier-synchronised allocation race summed correctly with no overshoot, and every buffer a tenant allocated next to a victim holding a secret came back zeroed; out-of-bounds accesses faulted at the GPU's per-context MMU.

The same scheme works for AMD on `/dev/kfd`, including rewriting the topology the ROCm runtime reads. One hardware detail bit us there: RDNA reports its VRAM heap as `heap_type 2` where CDNA uses `1`, and matching only one left a consumer card reporting a quota-correct free size next to the whole device's total.

Multi-GPU needed one more step. HAMi's `gpumem` is per device, so a pod with two GPUs at 50000 MiB each first got a single 50000 MiB pool for both. Scaling the total to 100000 would have let a pod stack it all on one GPU, into memory another tenant was promised. So the Sentry now attributes each allocation to the device it was made on and enforces a per-device limit too. On the B300, a tenant pod with two 50000 MiB shares sees 50000 MiB on each GPU, fits 45000 on both, and is refused 10000 more on either.

## Compute, and why it's hard

The obvious next move is to meter compute at the same boundary. It doesn't work, and it can't be made to.

Once an NVIDIA (or AMD) channel is set up, submitting work never enters the kernel. The application writes commands into a ring buffer in memory it has already mapped and rings a doorbell, a write to a mapped device register. We measured a sustained run of **13,000 kernel launches producing zero ioctls**. There is nothing for the Sentry to intercept.

### First attempt: take the mapping away

What submission does need is the ring buffer to be *mapped*. Following [Krypton (USENIX ATC '25)](https://www.usenix.org/conference/atc25), the Sentry revokes its own mapping of the command buffer at the end of a sandbox's share of each period. The next write faults into the Sentry, which holds the task until the share comes round again. The hold is against a deadline rather than a wakeup, both because the revoking goroutine needs the lock the faulting task holds and so that a sandbox can't escape by arranging to be signalled.

Against a kernel-launch loop on the RTX 5070 it divided cleanly: 76.2 %, 51.0 % and 25.8 % achieved against 75, 50 and 25 % configured.

A cap per sandbox isn't a share, though. A Sentry sees only its own sandbox, so time one sandbox doesn't use is wasted, and every sandbox's window starts at the same instant. So we added a coordinator outside all of them, `runsc gpu-scheduler`, one per node, which gives each sandbox a window over a Unix socket. Two choices made it work. Clients carry **weights**, not percentages: weight 200 gets twice the time of weight 100 on any GPU, active clients divide the period between them, and an idle one keeps only a 5 ms floor so it can come back. And windows are placed **end to end**, so exactly one sandbox is permitted at any instant instead of all at the start of the period and none at the end. (The Sentry's seccomp filter doesn't allow it to `connect()` anywhere, so `runsc` opens the socket on the way to starting the sandbox and donates the descriptor.)

Two pods at weights 300 and 100 got 486 and 162 launches/s, **3.00 : 1**, and kept 99 % of what one pod gets alone. Without the scheduler, they got 324 each.

### The hole: real workloads don't fault

Then we ran something people actually run. cuBLAS on Volta and later, and above all **CUDA graph replay**, which is how an inference server like vLLM spends most of its time, don't rebuild the command buffer per launch. They replay commands written once at capture time and ring the doorbell. The mapping the gate revokes is one the workload never touches again, so the fault the mechanism waits for never comes. Measured on a graph-replaying workload: roughly zero faults per period, running at full rate under a fractional share.

<div class="callout">
<p class="callout-title">The benchmark had the same blind spot as the mechanism</p>

The kernel-launch loop that produced the clean 76/51/26 table is the one workload shape the gate works against. We had validated the mechanism with the exception, not the rule. The fix for that isn't cleverness; it's testing with the workload that will actually run.
</div>

### The wrong turn

So we looked for anything that could impose a share on a doorbell workload. The GPU has its own scheduling machinery, a runlist scheduler in the GSP firmware that divides engine time between channel groups, and a work distributor that assigns SMs, both reachable through resource-manager controls that a container can't issue but a privileged host component can. We tried them all, at kernel privilege with the open driver. Every one appeared to fail. The timeslice control returned success and a 16 : 1 request produced 1 : 1. The spatial partition controls returned `0x57`, which we read as "not supported."

We wrote it all down, carefully and at length: consumer Blackwell honours none of these controls, and robust compute isolation for arbitrary CUDA is a property of MIG-capable datacenter silicon.

It was three of our own mistakes:

1. **A misread status code.** `0x56` is `NV_ERR_NOT_SUPPORTED`. `0x57` is `NV_ERR_OBJECT_NOT_FOUND`. The firmware hadn't refused the control; it couldn't find the object.
2. **The wrong call site.** We issued the controls from the constructor of the object they named, before it was registered with the firmware. From the deferred scheduling path, after registration, the identical control returns `NV_OK`.
3. **A missing commit.** The timeslice really did return success and do nothing, because a companion call, `RESTART_RUNLIST`, is what tells the firmware to act on a staged runlist change.

Each one, alone, produces a plausible negative that reproduces every time. Together they turned three software bugs into a confident statement about hardware.

### Letting the GPU divide itself

With the mistakes out, the problem looks different. You can't intercept submission. You don't need to: the GPU already has a scheduler, and it acts *below* the submission path, where a doorbell can't dodge it.

So NVIDIA compute enforcement moved into a small **driver broker**: hooks in the open kernel modules that let a trusted host component set each sandbox's runlist timeslices, commit them, and detach or reattach a sandbox's channel groups, through a root-only control file. The policy stays in `runsc gpu-scheduler`, which now drives the broker instead of (or as well as) the Sentry's gate. This is the same shape the GVM work arrived at on the A100: a privileged, driver-level broker. The constraint still holds, more firmly than before: the thing doing the limiting isn't just outside the container, it's in a different privilege domain. (The red team checked that the control file isn't visible inside a sandbox; a sandboxed process often runs as root, and if gVisor's synthetic `/proc` exposed it, one tenant could detach another.)

On the RTX 5070, the card we had written off, with two cuBLAS tenants under gVisor:

<div class="table-wrap">

| Configuration | Result |
|---|---|
| two tenants, equal weights | 220.7 / 220.7 matmul/s |
| weights 3 : 1 | 330 / 110 (**3.00 : 1**), total conserved |
| smaller tenant stops | survivor rises 330 → 457 (= solo) |
| three tenants, weights 3 : 2 : 1 | 3 : 2 : 1, conserved |
| 2 : 1, 6 : 1, 16 : 1 requested | 2.03 : 1, 6.15 : 1, 13.3 : 1 |

</div>

It's proportional, conserves throughput, hands an idle tenant's share to a busy one without any intervention, and stays linear to about 6 : 1. Run automatically from `runsc gpu-scheduler` on an A100, two cuBLAS pods weighted 3 : 1 divide 1067 / 344, **3.10 : 1**, at the same aggregate throughput as no enforcement. The same temporal control has now been confirmed on GB205 (RTX 5070), GA102 (RTX A6000), GA100 (A100) and the B300.

The spatial control works too, but it's a different primitive from what we hoped. Pinning a sandbox to 13, 18 or 24 of the 5070's 24 TPCs gives 272, 372 and 458 matmul/s, close to linear. But on the A100, two tenants on *disjoint* halves performed exactly like two on the *same* half: separate CUDA contexts time-slice the engine regardless, so the partition is a ceiling each tenant hits inside its own slice, not a way to run them side by side.

### The packing attack

The red team found the next hole within a day. The broker set a timeslice per channel group, and under gVisor every process in a sandbox shares one host identity. A tenant that forked N processes multiplied its channel groups without the scheduler seeing it. A weight-25 tenant running four processes beat its weight-75 neighbour **0.78 : 1**, against the 3.12 : 1 their honest weights produce. (Memory and containment held throughout; the break was only in the share.)

The fix is **credit accounting per tenant** (`pkg/gpusched/credit.go`): weight drives credit accrual, there is one large uniform quantum, consumed GPU time is charged back per tenant (weighted by the tenant's channel-group count, which the driver reports), and a tenant that overdraws has all its channel groups detached together. Forking can't help, because a tenant's channel groups share one pool. The property that hid the attack, one Sentry process per sandbox, is what makes per-tenant accounting unambiguous. With the weight-25 attacker forked into four processes (3 to 12 channel groups), the split now stays 2.3 to 2.75 : 1 in the honest tenant's favour against a 3 : 1 request, where it was 0.78 : 1 before. The residual tracks how much the attacker's work overlaps, not a scheduler bug, and a lone tenant pays nothing.

## AMD: the mirror image

AMD submits work the same way, by doorbell, so the same wall is there. The difference is what the Sentry can reach *around* submission. On NVIDIA the controls that divide the GPU sit behind privileged resource-manager calls; on AMD they're in ioctls `amdproxy` already interprets. So AMD gets both kinds of division entirely from the Sentry, on the stock driver.

**Space: CU masks.** A queue on RDNA or CDNA is created with a mask of compute units its work may use, and that mask is an ioctl argument. The Sentry narrows it to the sandbox's share, and the command processor enforces it from then on. Unlike NVIDIA's TPC partition, this is a real *concurrent* partition: two tenants on disjoint halves run at the same time on their own CUs. On a Navi 32, a tenant's rate moved −0.61 % when a neighbour started on the other half and +0.39 % when it left, the strongest isolation result in the project. Shares are exactly fair (Jain index 1.0000) up to three tenants. Two limits: RDNA pairs its CUs, so masks come in steps of two, and a mask partitions compute, not memory bandwidth, so three bandwidth-bound vLLM tenants still contend for VRAM bandwidth on disjoint CUs.

**Time: queue suspension, with no driver patch.** The KFD debug interface can suspend and resume a process's queues. Normally a debugger must ptrace its target, but the kernel skips that check when the target is the caller, and under gVisor's KVM platform the Sentry *is* the KFD process for the sandbox. So the Sentry opens a debug session on itself and suspends and resumes the sandbox's queues on a weighted duty cycle driven by the same `runsc gpu-scheduler`. AMD's hardware also does something NVIDIA's can't here: it **preempts mid-kernel**, saving and restoring in-flight waves, so a `vecadd` kernel stays correct while sliced at 25 %. Weights of 300 : 100 give 3.05 : 1, 500 : 100 give 5.13 : 1, and a lone tenant reclaims the device.

Holding the debug session open costs occupancy, not throughput, and the cost depends on the workload: −43 % for a register-heavy ALU-bound kernel, −0.003 % for a memory-bandwidth-bound one. LLM decode is bandwidth-bound, so time-slicing an inference tenant costs almost nothing.

The catch: on RDNA3 a queue can have a CU mask **or** be time-sliced, never both. The amdgpu driver refuses the debug session's wave save/restore workaround on a queue that carries a user CU mask, for every RDNA3 GC version. So the operator chooses per device: space, for concurrent tenants that still share the memory bus, or time, for weighted, work-conserving turns. `runsc` rejects a sandbox configured with both at startup.

<div class="table-wrap">

| | NVIDIA | AMD |
|---|---|---|
| Memory quota | Sentry, admit before forward | Sentry, admit before forward |
| Compute divided by | time: runlist timeslices via the driver broker (Sentry gate for launch-heavy work) | space (CU mask) **or** time (queue suspend), per device |
| Enforced by | GPU firmware scheduler, driven from a trusted host process | command processor (space), Sentry (time) |
| Driver | open kernel modules + broker hooks | stock |
| Preempts a running kernel | no | yes |

</div>

## Kubernetes, and back to vCluster

None of this is useful in a cluster unless something turns what a pod *asks for* into what `runsc` *enforces*. We keep HAMi's scheduler, device plugin and webhook exactly as shipped; they place pods and keep the books, and gVisor needs no scheduler of its own. We stop its limiter from being preloaded at all (and set its off switch as well, for good measure). An in-tree mutating webhook then restates each pod's admitted request as Sentry flags: `nvidia.com/gpumem` becomes a memory limit, `nvidia.com/gpucores` becomes a weight, for both vendors.

Two properties make that safe with a hostile tenant on the other side of a vCluster syncer, which, as the last post showed, passes annotations through verbatim:

- **Narrow-only.** The runtime's configured value is a ceiling an annotation can lower but never raise, and the webhook overwrites any self-written annotation higher than what the pod requested. On the A6000 cluster, a tenant requested 1024 MiB and annotated itself 40 GiB from inside its own vCluster, where it is cluster-admin; the sandbox saw 1024 MiB. On the B300, a tenant asked for the host's runc runtime and annotated 256 GiB at maximum weight; it ran under gVisor at the 20000 MiB and weight 20 it had requested. On AMD, an adversary claiming the whole card and the maximum weight next to three honest vLLM tenants was held to 9 % of the GPU, against the 10 % its request entitled it to.
- **Fail closed.** The webhook runs with `failurePolicy: Fail`, and a GPU sandbox that can't reach the scheduler doesn't start. That's a security property, not an availability preference: an unmutated pod would run at the whole-device ceiling.

In this stack, vCluster, HAMi and the webhook are trusted placement and translation. Only two things enforce against a hostile tenant: the Sentry, and for NVIDIA compute, the driver broker. A tenant who gets past everything else still runs into those.

## Scaling up: an 8× B300 box

The B300 node (eight GPUs on NVSwitch) was where the stack met multi-GPU, and where we learned the most about bugs that only appear at scale. Everything below ran under gVisor, from inside vCluster tenants where noted:

<div class="table-wrap">

| Test | Result |
|---|---|
| 8-GPU pod | 10.86 PFLOPS, ~718 GiB/s to every peer, NCCL all-reduce 696 GB/s bus bandwidth |
| 4-GPU pod from a tenant | all-pairs P2P, ~715 GiB/s NVLink copy, NCCL 624 GB/s |
| 75 / 25 on one GPU, cuBLAS, from a tenant | 2.80 : 1 |
| weight-25 pod alone on its GPU, beside a 75 / 25 pair | 1332 TFLOPS (894 before per-GPU planning) |
| fractional pod, 1 GPU, 40000 MiB | sees 40000 MiB, 1316 TFLOPS bf16 alone |

</div>

The bugs were instructive because two of them failed *open*, silently. The broker kept a fixed table of channel groups and never freed entries. An 8-GPU NCCL pod takes about 110 slots, so after ten sandboxes the table was full, and a 75 / 25 pair then split **645 : 644** with nothing logged. Separately, every broker command went to whichever GPU had last registered a group, so 147 of 168 timeslice calls on an 8-GPU pod failed, and one tenant opening a context on GPU B could take enforcement away from a pair on GPU A. And the scheduler ran one credit planner across the whole node, so sandboxes on different GPUs competed for the same pool. All three are fixed: entries are freed and a full table is logged, each group carries its own GPU, and there's one planner per device.

## What it costs, and what's still open

<div class="table-wrap">

| Limit | Detail |
|---|---|
| Trusted computing base | NVIDIA compute needs our patched open kernel modules; the broker is host-kernel code |
| Fail-closed scheduler | if `runsc gpu-scheduler` is down, GPU pods don't start |
| Long kernels on NVIDIA | submitted work can't be recalled; a kernel longer than its window overruns, and charge-back only recovers part of it |
| Usage measurement | the `nvidia-smi pmon`-based overrun accounting misprices ordinary workloads (31 / 618 launches/s instead of 324 / 324) and is off in our setup |
| Sentry gate stalls | while the gate holds a sandbox, its other threads stall on address-space operations; an mmap-heavy thread drops to ~20 % under a 25 % cap (the broker path doesn't have this cost) |
| Granularity | 100 ms periods; latency-sensitive inference at a small share will feel it |
| NVIDIA spatial | a cap, not concurrency |
| AMD | space or time per device on RDNA3, never both; `hipMallocManaged` doesn't work (SVM is denied) |
| Memory accounting | unified memory charged at reservation; fabric memory and EGM not yet accounted |
| Side channel | live power draw is still visible to a sandbox, a low-bandwidth signal of a neighbour's activity |
| Checkpoint/restore | no GPU sandbox can be checkpointed yet; several object types the driver creates for every CUDA context don't implement restore |

</div>

## What we'd tell ourselves two months ago

The first version of this work ended on a hardware fact: work submitted to a GPU can't be recalled, so you can't intercept your way to compute isolation. That's true, and it turned out to be a limit on *interception*, not on *scheduling*. The GPU will divide its own time between tenants if you ask it correctly, and "correctly" was the entire difficulty: the right control, on a live object, followed by the call that makes the firmware act. For several days, three small mistakes about how to ask looked exactly like a fact about what's possible. What settled it wasn't a better argument. It was reading one status code correctly and moving one call to a later point in the code.

The other lesson is the one from the last post, again: test like the tenant is lying to you. Every real hole here, from graph replay to process packing to a silently full table, was invisible to a benchmark that behaved itself.

The design overview is [`GPU-ISOLATION.md`](https://github.com/pvnis/gvisor/blob/gpuslicing/GPU-ISOLATION.md), with the red-team record in [`SECURITY-FINDINGS.md`](https://github.com/pvnis/gvisor/blob/gpuslicing/SECURITY-FINDINGS.md) and the cluster setup in [`vcluster-multitenant`](https://github.com/pvnis/vcluster-multitenant). We plan to send two general fixes upstream to gVisor, and we'd like to talk to anyone who wants to try this on their own hardware, especially GPUs we haven't measured yet. We've learned not to predict them.
