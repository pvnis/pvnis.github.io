---
layout: post.njk
title: "Slicing an NVIDIA GPU between tenants who don't trust each other"
description: "How we divide one NVIDIA GPU's memory and compute between gVisor sandboxes: quotas in the Sentry, a broker in the open kernel driver, and a credit scheduler that a tenant can't game by forking."
author: Dan Mihai Dumitriu
date: 2026-10-14
tags: [posts, gVisor, GPU, NVIDIA, Kubernetes, multi-tenancy]
---

A GPU server shared by several teams is only worth sharing if each team gets the slice it was promised, and none of them can take more by misbehaving. That second half is what existing tools mostly don't do. The common answers either need datacenter hardware with fixed partition sizes, give up isolation, or put the thing doing the limiting inside the container it is supposed to limit.

This post describes how we slice NVIDIA GPUs between mutually untrusting containers. Memory quotas are enforced in [gVisor](https://gvisor.dev)'s userspace kernel, the Sentry. Compute shares are enforced by the GPU's own scheduler, driven from the host through a small broker we added to NVIDIA's open kernel modules. The policy is a credit scheduler that a tenant can't game by forking. It runs on consumer and datacenter parts alike: an RTX 5070, an RTX A6000, an A100 and an 8× B300 box. The code is on the `gpuslicing` branches of our forks of [gVisor](https://github.com/pvnis/gvisor/tree/gpuslicing) and of [open-gpu-kernel-modules](https://github.com/pvnis/open-gpu-kernel-modules/tree/gpuslicing).

<div class="stats">
  <div class="stat"><b>0</b><span>ioctls during 13,000 CUDA kernel launches, which is why compute is hard</span></div>
  <div class="stat"><b>0.78 → 2.75</b><span>share ratio for a 3 : 1 request once the low-weight tenant forks, before and after credit scheduling</span></div>
  <div class="stat"><b>99.9 %</b><span>of solo throughput for a lone tenant with the scheduler running</span></div>
  <div class="stat"><b>696 GB/s</b><span>NCCL all-reduce bus bandwidth across 8 GPUs, inside a gVisor sandbox</span></div>
</div>

## Nothing inside the container

The design follows from one rule: **no limit may depend on anything inside the container.** On a shared GPU the workload is the adversary, and a limit it can reach is a limit it can lift.

[HAMi](https://project-hami.io) shows why this matters. Its scheduler is genuinely good: it understands requests like `nvidia.com/gpumem` and `nvidia.com/gpucores` and places pods so they fit on a device. Its enforcement is `libvgpu.so`, preloaded into the container to intercept CUDA calls, and it reads an environment variable, `CUDA_DISABLE_CONTROL`, that switches it off. On a live cluster, the same pod three ways:

<div class="table-wrap">

| HAMi limiter | Sentry limit | Device size the pod sees | Outcome |
|---|---|---|---|
| loaded | none | 512 / 512 MiB | refused at 512 MiB |
| not loaded | none | 11347 / 11790 MiB | **allocated all 768 MiB it asked for** |
| not loaded | 512 MiB | 350 / 512 MiB | refused at 320 MiB |

</div>

Row two is what a tenant gets by setting one variable. Row three is the same pod with the limit enforced somewhere it can't reach. So we kept HAMi's placement unchanged and rebuilt the enforcement elsewhere.

## Three pieces, and who trusts whom

gVisor runs a container against the Sentry, a kernel written in Go that runs in userspace, instead of the host kernel. Every syscall the application makes, including every ioctl on `/dev/nvidiactl`, `/dev/nvidia0` and `/dev/nvidia-uvm`, lands in the Sentry first. Upstream gVisor already proxies these (`nvproxy`), checking each call against an allowlist of driver structures before forwarding it. That boundary is about the *shape* of each call. We added *quantity*.

There are three pieces:

1. **`nvproxy` in the Sentry** enforces memory quotas, because every allocation passes through it.
2. **`runsc gpu-scheduler`**, one process per node on the host, holds the compute policy: who has which weight, and on which GPU.
3. **A broker in the open kernel modules** applies that policy to the GPU's own scheduler. Only kernel code can do that.

The split is deliberate. The Sentry is outside the container, but it runs that tenant's code paths, so we treat it as no more trusted than the tenant it serves. Anything that can affect *other* tenants, like detaching their work from the GPU, lives in the host scheduler and the driver, never in a Sentry.

<figure class="diagram">
<svg viewBox="0 0 720 430" role="img" aria-labelledby="nv-title">
  <title id="nv-title">A CUDA application in a gVisor sandbox makes ioctls that the Sentry's nvproxy checks and charges against a memory quota before forwarding them to the NVIDIA kernel driver. The application submits compute work by writing to mapped memory and ringing a doorbell, which goes straight to the GPU without any syscall. A host process, runsc gpu-scheduler, reads each tenant's activity and channel-group count from the driver's broker interface and writes timeslices and detach or attach commands, each committed with a runlist restart, to the GPU's firmware scheduler.</title>
  <defs><marker id="ah-nv" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="dg-arrow"/></marker></defs>
  <rect class="dg-zone" x="50" y="20" width="310" height="212" rx="8"/>
  <text class="dg-z" x="66" y="40">gvisor sandbox · one tenant</text>
  <rect class="dg-box" x="66" y="52" width="278" height="46" rx="6"/>
  <text class="dg-t" x="205" y="72" text-anchor="middle">CUDA application</text>
  <text class="dg-s" x="205" y="90" text-anchor="middle">unmodified · nothing preloaded</text>
  <line class="dg-line" x1="205" y1="98" x2="205" y2="150" marker-end="url(#ah-nv)"/>
  <text class="dg-s" x="215" y="128">ioctls</text>
  <rect class="dg-box key" x="66" y="152" width="278" height="66" rx="6"/>
  <text class="dg-t" x="205" y="172" text-anchor="middle">Sentry · nvproxy</text>
  <text class="dg-s" x="205" y="190" text-anchor="middle">memory quota, charged before forwarding</text>
  <text class="dg-s" x="205" y="206" text-anchor="middle">device sizes reported as the quota</text>
  <polyline class="dg-line" points="66,75 40,75 40,370" style="stroke-dasharray:5 4" marker-end="url(#ah-nv)"/>
  <text class="dg-s" transform="translate(30,225) rotate(-90)" text-anchor="middle">doorbell write · never a syscall</text>
  <rect class="dg-box key" x="420" y="52" width="280" height="66" rx="6"/>
  <text class="dg-t" x="560" y="74" text-anchor="middle">runsc gpu-scheduler (host)</text>
  <text class="dg-s" x="560" y="92" text-anchor="middle">weights · one credit planner per GPU</text>
  <text class="dg-s" x="560" y="108" text-anchor="middle">pid announced by runsc at start</text>
  <line class="dg-line" x1="205" y1="218" x2="205" y2="270" marker-end="url(#ah-nv)"/>
  <text class="dg-s" x="215" y="250">forwarded if within quota</text>
  <line class="dg-line" x1="530" y1="118" x2="530" y2="270" marker-end="url(#ah-nv)"/>
  <text class="dg-s" x="522" y="178" text-anchor="end">ts · detach · attach</text>
  <text class="dg-s" x="522" y="194" text-anchor="end">+ RESTART_RUNLIST</text>
  <line class="dg-line" x1="620" y1="270" x2="620" y2="120" marker-end="url(#ah-nv)"/>
  <text class="dg-s" x="630" y="178">poll</text>
  <text class="dg-s" x="630" y="194">active, tsgs</text>
  <rect class="dg-box" x="66" y="272" width="634" height="58" rx="6"/>
  <text class="dg-t" x="383" y="294" text-anchor="middle">NVIDIA open kernel modules + broker hooks</text>
  <text class="dg-s" x="383" y="314" text-anchor="middle">/proc/driver/nvidia/gpusched · root only · not visible in any sandbox</text>
  <line class="dg-line" x1="383" y1="330" x2="383" y2="370" marker-end="url(#ah-nv)"/>
  <rect class="dg-box" x="20" y="372" width="680" height="44" rx="6"/>
  <text class="dg-t" x="360" y="398" text-anchor="middle">GPU · GSP runlist scheduler · channel groups (TSGs) · VRAM</text>
</svg>
<figcaption>Memory goes through the Sentry. Compute submission doesn't, so compute is divided below it, by the GPU's own runlist scheduler, under the control of a host process the tenant can't reach.</figcaption>
</figure>

## Memory: quotas in the Sentry

GPU memory is allocated through ioctls, so the Sentry can count it. The idea is simple: charge each allocation against the sandbox's quota and refuse the one that would cross it. The details are where the work went.

- **Charge before forwarding.** The charge is taken before the ioctl reaches the driver and returned if the driver refuses. Otherwise two concurrent allocations could both be admitted against the same headroom. A red-team run with four processes racing allocations behind a barrier summed correctly, with no overshoot.
- **Count aliases once.** `NV_ESC_RM_DUP_OBJECT` creates a second handle to existing memory, so charges are reference counted. They are released from the cascade that frees an object's dependents, the only place that sees all of them.
- **Unified memory is charged at reservation.** CUDA unified memory is populated by GPU page faults that the host's `nvidia-uvm` module services internally, without any ioctl the Sentry could see. What the Sentry *can* see is the address-space reservation, so that is what it charges, together with device memory. It's a sound bound, but a workload that deliberately oversubscribes pays for what it reserved.
- **Every allocation class makes an explicit decision.** A class added to the allowlist without an accounting rule fails a test instead of silently going uncharged.

The Sentry also makes the limit *visible*. It rewrites the sizes the driver reports, so `cuMemGetInfo()`, NVML and `nvidia-smi` inside the sandbox show the quota, not the card. Frameworks size their memory pools from those calls, so an unmodified PyTorch or vLLM fits itself into its slice instead of confidently allocating past it. An over-quota allocation fails with `CUDA_ERROR_OUT_OF_MEMORY`, exactly as on a full GPU.

Multi-GPU pods needed one more step. HAMi's `gpumem` is per device, so a pod with two GPUs at 50000 MiB each should get 50000 MiB on each, not 100000 MiB to spend anywhere. Spending it anywhere would let a pod stack its whole allowance on one GPU, into memory promised to another tenant. So nvproxy attributes every allocation to the device it was made on and enforces a per-device limit as well as the total. On a B300, such a pod sees 50000 MiB on each GPU, fits 45000 MiB on both, and is refused 10000 MiB more on either.

In red-team runs, every buffer a tenant allocated next to a victim holding a secret came back zeroed, and out-of-bounds accesses faulted at the GPU's per-context MMU.

## Compute: why the Sentry can't do it

The natural next step is to meter compute at the same boundary. It can't be done. Once a CUDA channel is set up, submitting work doesn't enter the kernel: the application writes commands into a ring buffer in memory it has already mapped, then writes to a mapped device register, the doorbell. We measured **13,000 kernel launches producing zero ioctls**. There's nothing for the Sentry to intercept.

Our first attempt worked around that, following [Krypton (USENIX ATC '25)](https://www.usenix.org/conference/atc25). Submission needs the ring buffer to be *mapped*, so the Sentry revokes its own mapping of the command buffer when a sandbox's share of each period runs out. The next write faults into the Sentry, which holds the task until its share comes round. Against a kernel-launch loop it divided cleanly: 76.2 %, 51.0 % and 25.8 % of the GPU against 75, 50 and 25 % configured.

Then we ran cuBLAS. On Volta and later, cuBLAS GEMMs and especially CUDA graph replay, which is how an inference server like vLLM spends most of its time, don't rewrite the command buffer per launch. They replay commands written once and ring the doorbell. The revoked mapping is never touched again, so the fault never arrives. Two cuBLAS tenants weighted 3 : 1 under this gate ran at **706 and 706** matmul/s.

<div class="callout">
<p class="callout-title">The benchmark shared the mechanism's blind spot</p>

The kernel-launch loop that validated the gate is the one workload shape the gate can bind. The clean 76 / 51 / 26 table measured the exception, not the rule. The fix wasn't cleverness, it was testing with the workloads that would actually run.
</div>

The gate also had a cost: while it holds a sandbox, the faulting task holds the sandbox's address-space lock, so other threads stall on anything that needs it. A thread doing continuous `mmap` and `munmap` fell to about 20 % of its normal rate under a 25 % cap. The gate is still in the tree, but on a node where the broker is running it stands down (more on why below).

## The GPU already has a scheduler

The GPU divides its own time. Work is organised in channel groups (TSGs), and the GSP firmware runs a **runlist** scheduler that rotates between them, giving each a timeslice. It acts *below* the submission path, so a doorbell can't dodge it. The controls that configure it, setting a channel group's timeslice and removing it from or restoring it to the runlist, are resource-manager calls that need kernel privilege. A container can't issue them. A trusted host component can.

We tried them at kernel privilege with the open driver, and for several days every one appeared to fail. The timeslice control returned `NV_OK`, and a 16 : 1 setting produced 1 : 1. Detaching a running tenant's channels did nothing. The spatial partition controls returned `0x57`, which we read as "not supported." We wrote a careful, detailed conclusion: consumer Blackwell honours none of these, and compute isolation for arbitrary CUDA needs MIG-capable datacenter silicon.

It was three mistakes of our own:

1. **A misread status code.** `0x56` is `NV_ERR_NOT_SUPPORTED`. `0x57` is `NV_ERR_OBJECT_NOT_FOUND`. The firmware hadn't refused the control; it couldn't find the object the control named.
2. **The wrong call site.** We issued the controls from the constructor of the object they named, before it was registered with the firmware. From the deferred scheduling path, after registration, the identical control returns `NV_OK`.
3. **A missing commit.** GSP doesn't act on a staged runlist change until the runlist is restarted. `NVA06F_CTRL_CMD_RESTART_RUNLIST` is that commit. Without it, both the timeslice change and the detach looked inert.

Each mistake alone produced a plausible negative that reproduced every time. Together, they turned three software bugs into a confident statement about hardware. With the restart added, the levers work, on the A100 first: detaching one of two running tenants handed the survivor the whole GPU (710 → 1551 matmul/s), reattaching restored the even split, and a 16 : 1 timeslice ratio shifted throughput 14 : 1.

## The broker

The broker is a small set of hooks in the open kernel modules (in the channel-group and context-share code) that expose one root-only file:

```text
# echo poll > /proc/driver/nvidia/gpusched     # refresh each tenant's GP_PUT
# cat /proc/driver/nvidia/gpusched             # (example output)
pid 41822 active 1 tsgs 3
dev 0000:07:00.0 pid 41822 active 1 tsgs 3
pid 41907 active 1 tsgs 12
dev 0000:07:00.0 pid 41907 active 1 tsgs 12
stats cmds_ok 1840 cmds_failed 0 restarts_ok 1840 restarts_teardown 2 restarts_failed 0 table_full 0

# echo "ts 41822 4000 0000:07:00.0"     > /proc/driver/nvidia/gpusched
# echo "detach 41907 0000:07:00.0"      > /proc/driver/nvidia/gpusched
# echo "attach 41907 0000:07:00.0"      > /proc/driver/nvidia/gpusched
```

`poll` makes the driver re-read each channel's GPFIFO put pointer, and reading the file then reports, per tenant and per GPU, whether any of its channel groups advanced (a doorbell-aware activity signal the tenant can't forge) and how many channel groups it holds. `ts` sets a tenant's timeslice, and `detach` and `attach` remove its channel groups from the runlist or restore them. The driver commits each with `RESTART_RUNLIST`, from an RM work item that holds the GPU locks. The optional PCI address restricts a command to one GPU.

Tenants are identified by host pid, and gVisor makes that unusually clean. The driver attributes a channel group to the process that opened the device, which for a sandbox is always its Sentry. So every process inside one sandbox, however many the tenant forks, shows up as **one pid**. The scheduler never has to guess which processes belong together.

The broker is mechanism only. It holds no policy, and it isn't reachable by tenants: it's root-only in the host's `/proc`, and gVisor's synthetic `/proc` doesn't expose it. We checked from inside a sandbox, because a sandboxed process often runs as root and could otherwise detach its neighbours. A tenant can still issue the unprivileged timeslice control on its own channel groups through nvproxy, which can clamp it, but it can't issue the privileged restart that would make the change take effect.

## The policy: `runsc gpu-scheduler`

The scheduler runs one per node and keeps one planner per GPU. It learns about sandboxes in two ways. When `runsc` starts a GPU sandbox, it connects to the scheduler and hands the open socket to the Sentry, because the Sentry's seccomp filter forbids it to `connect()` to anything. That connection carries the sandbox's weight. Separately, `runsc` announces the sandbox's host pid once the Sentry process exists, which is the first moment the pid is known.

Getting from a working mechanism to an automatic one took three more fixes, each hiding the next:

- **The pid announcement could be lost.** It was a single message with no retry, and the scheduler forgot it if the weight connection dropped. It now retries, and the pid is kept as a property of the sandbox.
- **The plan has to be re-asserted.** A plan written once, a few seconds into a pod's life, landed before the tenant had created its cuBLAS channel groups, so the real ones appeared later at the driver default. The scheduler now re-asserts the full plan every ~2 s, binding any channel group created since.
- **The gate has to stand down.** If the Sentry's gate revokes a sandbox's mappings, the sandbox stops submitting, its GPFIFO drains, and the driver reports it idle, which disturbs the division. With the broker running, every sandbox gets a full-period window, so the gate never revokes and the runlist alone does the dividing.

The first policy that worked set each tenant's timeslice proportional to its weight. On an A100, fully automatic, two cuBLAS pods weighted 3 : 1 divided **1067 : 344 (3.10 : 1)** at the same aggregate throughput as no enforcement. For a day, we thought we were done.

## The packing attack

The red team broke it by forking. A timeslice binds a *channel group*, and a tenant owns as many as it creates: each CUDA context creates several, and a tenant that forks four processes creates four times as many. With the share encoded as a per-group timeslice, a tenant's share tracked (channel groups × timeslice). On an A6000, a tenant granted a quarter of the GPU ran four processes in its own pod and took more than a neighbour weighted three times higher: **0.78 : 1** against the requested 1 : 3. Memory and containment held; the share didn't.

The obvious fix, dividing a tenant's timeslice among its channel groups, restored the ratio but cost **42 %** of aggregate throughput, because smaller timeslices multiply context switches.

The fix that worked is credit accounting per tenant, the scheme described in the GVM paper ("OS-Level GPU Virtualization", Berkeley/UCLA). It is in [`pkg/gpusched/credit.go`](https://github.com/pvnis/gvisor/blob/gpuslicing/pkg/gpusched/credit.go):

- **Every channel group gets the same large quantum**, 4 ms. The quantum only sets how often the GPU switches, not who gets what.
- **Weight sets how fast a tenant accrues credit.** Each tick, the time a tenant consumed is charged back against its credit.
- **The charge is by channel-group share**, read from the broker's `tsgs` field. A tenant holding *n* of the *N* attached groups really does take *n/N* of the device, so that's what it's charged. Charging every tenant the same would under-charge exactly the attacker this exists to stop.
- **A tenant that overdraws is detached, all its groups together**, and reattached when it recovers. Forking can't help: fifteen channel groups drain one credit pool fifteen times faster.

Two details turned out to be load-bearing. A **dead band** is required: detaching at zero credit makes tenants that are getting exactly their share flap on and off every tick. And a **detached tenant still counts as wanting to run**. Once detached, its GPFIFO stops advancing and the driver reports it idle forever, so the scheduler, not the activity signal, has to remember it.

<div class="table-wrap">

| | Weight 75 tenant | Weight 25 tenant | Ratio |
|---|---:|---:|---:|
| A6000, timeslice scheme, honest | 126.8 | 40.7 | 3.12 : 1 |
| A6000, timeslice scheme, weight-25 tenant forks 4 | 70.5 | 90.9 | **0.78 : 1** |
| A6000, credit, honest | 100.9 | 35.3 | 2.86 : 1 |
| A6000, credit, weight-25 tenant forks 4 | 93.9 | 41.4 | **2.27 : 1** |
| RTX 5070, credit, honest | 131.4 | 40.0 | 3.29 : 1 |
| RTX 5070, credit, weight-25 tenant forks 4 (3 → 12 TSGs) | 125.7 | 45.7 | **2.75 : 1** |

</div>

All figures are cuBLAS SGEMM matmul/s, counted as completed work over the run window. The packer keeps a small edge, 31 % of the A6000 and 27 % of the 5070 against a granted 25 %, so this is blunted rather than perfect. The edge moves *inversely* to the attacker's channel-group advantage, which tells us it isn't under-charging. It tracks how much spare capacity the device has, which brings us to cost.

The same result held with real tenants. Four tenants, each in its own vCluster on one RTX 5070, three serving vLLM (Qwen2.5-0.5B) under load at weights 100 / 50 / 25 and one adversary: the honest split was 4.25 : 2.12 : 1 against a nominal 4 : 2 : 1, and when the adversary went from one process to four (3 → 12 channel groups), its throughput went from 31 to 27 matmul/s.

## What enforcement costs

Enforcement has no fixed cost. What it can give up is an overlap bonus, which only exists when the GPU has slack.

<div class="table-wrap">

| | RTX 5070 | RTX A6000 |
|---|---:|---:|
| one tenant, no scheduler | 171.4 | 139.4 |
| one tenant, credit scheduler | 173.3 (no measurable cost) | 139.3 (99.9 %) |
| two tenants, no enforcement | — | 167.5 (120 % of solo) |
| two tenants, credit scheduler | 171.4 (= solo) | 136.2 (98 % of solo) |

</div>

A lone tenant pays nothing. On the 5070, one cuBLAS stream already saturates the card, so two enforced tenants together get exactly what one gets alone. On the A6000, one stream doesn't saturate it, so two *unenforced* tenants interleave and fill each other's gaps, beating a lone tenant by 20 %. Enforcing a share serialises them and gives that bonus up. We first reported the A6000 figure as 20 % scheduler overhead, which it isn't. Measuring the single-tenant baseline, the run everyone skips, is what told the two apart.

## In Kubernetes

None of this helps in a cluster unless something turns what a pod *asks for* into what `runsc` *enforces*. HAMi's scheduler, device plugin and webhook run unchanged: they place pods and keep the books. Its limiter is no longer preloaded into containers. An in-tree mutating webhook restates each pod's admitted request as Sentry flags: `nvidia.com/gpumem` becomes a memory limit (per device, for multi-GPU pods), and `nvidia.com/gpucores` becomes a scheduler weight.

Two properties matter when the pod spec is written by the tenant:

- **Narrow-only.** The value configured on the runtime is a ceiling that a pod annotation can lower but never raise, and the webhook overwrites any self-written annotation above what the pod requested. A tenant who requested 1024 MiB and annotated itself 40 GiB saw 1024 MiB. On the B300, a tenant that asked for the host's runc runtime and annotated 256 GiB at maximum weight ran under gVisor at the 20000 MiB and weight 20 it had requested.
- **Fail closed.** The webhook runs with `failurePolicy: Fail`, and a GPU sandbox that can't reach the scheduler doesn't start. An unmutated or unscheduled pod would run at the whole-device ceiling, so failing open would be a quota escape.

We run each tenant in its own vCluster, as cluster-admin of a virtual cluster with every control applied on the host side; the runtime class is forced to gVisor whatever the pod asks for. That layer is a separate post.

## Eight B300s

The B300 node (eight GPUs on NVSwitch) was where we met multi-GPU, and its bugs were the most instructive in the project, because three of them failed *open*, silently.

- **The broker's table never freed entries.** Every channel group took a slot, and a slot was never released. An 8-GPU NCCL pod takes about 110, so after ten such sandboxes the table was full, new tenants weren't tracked, and a 75 / 25 pair split **645 : 644** with nothing logged.
- **Every broker command went to one GPU**, whichever had last registered a group. 147 of 168 timeslice calls on an 8-GPU pod failed with `0x57`, and a tenant opening a context on one GPU could take enforcement away from a pair on another.
- **One credit pool served the whole node**, so sandboxes on different GPUs competed for credit. A weight-25 pod alone on its GPU got 894 TFLOPS instead of ~1330.

All three are fixed: slots are freed at channel-group teardown, each group carries its own GPU, and the scheduler keeps one planner per GPU. That left the obvious follow-up attack: fill the table with idle contexts, and new work goes untracked. A weight-25 tenant took **814 TFLOPS** against its weight-75 neighbour's 371 that way. Now a channel group is recorded before the firmware enables it, a group that can't be recorded is refused once a scheduler is running, and one tenant can hold at most a quarter of the table.

With that in place, from inside a gVisor sandbox:

<div class="table-wrap">

| Test | Result |
|---|---|
| 8-GPU pod | 10.86 PFLOPS, ~718 GiB/s to every peer, NCCL all-reduce 696 GB/s bus bandwidth |
| 4-GPU pod, from a tenant | all-pairs P2P, ~715 GiB/s NVLink copy, NCCL 624 GB/s |
| 75 / 25 on one GPU, cuBLAS, from a tenant | 2.80 : 1 |
| weight-25 pod alone on its GPU, beside a 75 / 25 pair | 1332 TFLOPS |
| weight-25 pod on two GPUs, one shared with a weight-75 pod | 1313 TFLOPS on its own GPU, 329 : 1022 on the shared one |

</div>

`nvidia-smi topo -m` also needed fixing: NVML places each GPU by walking `/sys/bus/pci/devices`, which a sandbox didn't have. gVisor now gives nvproxy sandboxes a read-only snapshot of the GPUs' PCI topology, so NCCL sees the NVLink fabric.

## What doesn't work yet

- **A patched driver.** The broker is host kernel code in our fork of the open modules. Memory quotas work on a stock driver; compute shares don't.
- **The scheduler is a single point of failure.** It fails closed, on purpose: with it down, GPU pods don't start.
- **Long kernels overshoot.** A GPU can't be made to abandon work already submitted. A kernel longer than its turn runs to completion, and credit charge-back recovers the time afterwards instead of preventing it.
- **The packing edge is blunted, not gone**, at 2 to 6 points above the granted share in our measurements.
- **Spatial partitioning is a ceiling, not concurrency.** The TPC partition control works once issued from the right place (13, 18 and 24 of the 5070's 24 TPCs give 272, 372 and 458 matmul/s), but two tenants on disjoint halves perform the same as two on the same half, because separate contexts still take turns on the engine.
- **Memory accounting gaps.** Unified memory is charged at reservation, and fabric memory and EGM aren't accounted yet.
- **Telemetry.** A sandbox can still read the GPU's live power draw, a low-bandwidth signal of a neighbour's activity.
- **No checkpoint/restore** of a CUDA sandbox: several object types every CUDA context creates don't implement restore in nvproxy.
- **Each GPU gets measured.** The runlist path is confirmed on GB205 (RTX 5070), GA102 (RTX A6000), GA100 (A100) and the B300. We no longer predict a new die from its class; that is the mistake that cost us the most.

## What we'd tell ourselves two months ago

Work submitted to a GPU can't be intercepted, and we treated that as a limit on compute isolation. It's a limit on *interception*. The GPU will divide its own time between tenants if you ask it correctly, and "correctly" was the entire difficulty: the right control, on a live object, followed by the call that makes the firmware act. For several days, three small mistakes about *how to ask* looked exactly like a fact about *what's possible*. What settled it wasn't a better argument. It was reading one status code correctly and moving one call to a later point in the driver.

The other lesson is to test like the tenant is lying to you. Graph replay, process packing and a silently full table were each invisible to a benchmark that behaved itself, and each was found by someone trying to cheat.

The design overview is [`GPU-ISOLATION.md`](https://github.com/pvnis/gvisor/blob/gpuslicing/GPU-ISOLATION.md), the driver side is [`DRIVER-CHANGES.md`](https://github.com/pvnis/open-gpu-kernel-modules/blob/gpuslicing/DRIVER-CHANGES.md), and the red-team record is [`SECURITY-FINDINGS.md`](https://github.com/pvnis/gvisor/blob/gpuslicing/SECURITY-FINDINGS.md). AMD turned out to be a mirror image, with both kinds of division reachable from the Sentry on a stock driver. That's another post.
