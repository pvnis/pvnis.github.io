---
layout: post.njk
title: "Stop asking, start predicting: SAGE cuts 5G uplink latency by 2.5×"
description: "Our SIGCOMM 2026 paper with EPFL: a real-time AI system at the gNB that predicts when and how much a phone will send, and grants the uplink before it asks."
author: Dan Mihai Dumitriu
date: 2026-10-07
tags: [posts, 5G, RAN, latency, AI]
---

Cellular networks got fast a while ago. What they never got is *prompt*, and most of the delay is on the way up: before a phone may send a single uplink byte, it has to ask the base station for permission, and usually it has to ask twice. Our paper **[SAGE: A Real-Time AI System for Reducing Latency in NextG Cellular Networks](https://doi.org/10.1145/3789240.3829112)**, written with Haitham Hassanieh's group at EPFL and published at ACM SIGCOMM 2026 in Denver, takes that waiting out of the loop. The gNB learns each user's traffic, predicts when the next uplink burst will arrive and how big it will be, and has a grant ready when it does.

It needs no change to the 3GPP protocol, the phone or the radio: SAGE is software at the gNB and its RAN controllers. On a real over-the-air testbed with commercial 5G modules and eight real applications:

<div class="stats">
  <div class="stat"><b>2.53×</b><span>lower uplink latency than grant-based access, on average</span></div>
  <div class="stat"><b>1.59×</b><span>the radio resources of grant-based access, on average</span></div>
  <div class="stat"><b>37.5×</b><span>fewer resources than grant-free baselines (up to), at comparable latency</span></div>
  <div class="stat"><b>51 µs</b><span>average inference time per prediction, on one CPU thread</span></div>
</div>

This post is the short version: why the uplink is slow, why predicting it is harder than it sounds, and what we built. The paper has the full design, the analytical model and many more experiments.

## Why the uplink waits

A 5G phone with new data can't just transmit. In **grant-based access** it waits for its next Scheduling Request (SR) opportunity, which can be as far as 40 ms away in commercial networks, and sends an SR. The gNB answers with a small fixed grant, just enough for a sliver of data and a Buffer Status Report (BSR) saying how much is still queued. Only then does the gNB grant the rest. That is at least two request/grant round trips before the bulk of a burst moves.

<figure class="diagram">
<svg viewBox="0 0 720 270" role="img" aria-labelledby="ul-title">
  <title id="ul-title">Timeline comparison. Grant-based: a burst arrives, the UE waits for an SR slot and an SR grant, sends a BSR and waits for a second grant, then sends the data. SAGE: a grant is already scheduled around the predicted arrival, so the data goes out immediately.</title>
  <defs><marker id="ah2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" class="dg-arrow"/></marker></defs>
  <text class="dg-z" x="20" y="30">grant-based (today)</text>
  <line class="dg-line" x1="20" y1="96" x2="700" y2="96" marker-end="url(#ah2)"/>
  <line class="dg-line" x1="80" y1="44" x2="80" y2="96"/>
  <text class="dg-s" x="80" y="40" text-anchor="middle">burst arrives</text>
  <rect class="dg-box" x="80" y="60" width="210" height="30" rx="6"/>
  <text class="dg-t" x="185" y="80" text-anchor="middle">wait SR slot · SR → grant</text>
  <rect class="dg-box" x="294" y="60" width="180" height="30" rx="6"/>
  <text class="dg-t" x="384" y="80" text-anchor="middle">small data + BSR → grant</text>
  <rect class="dg-box key" x="478" y="60" width="110" height="30" rx="6"/>
  <text class="dg-t" x="533" y="80" text-anchor="middle">data</text>
  <text class="dg-s" x="185" y="116" text-anchor="middle">1st round trip</text>
  <text class="dg-s" x="384" y="116" text-anchor="middle">2nd round trip</text>
  <text class="dg-z" x="20" y="168">SAGE</text>
  <line class="dg-line" x1="20" y1="234" x2="700" y2="234" marker-end="url(#ah2)"/>
  <rect class="dg-zone" x="50" y="190" width="170" height="38" rx="6"/>
  <text class="dg-s" x="135" y="256" text-anchor="middle">grants pre-allocated around predicted slot</text>
  <line class="dg-line" x1="80" y1="182" x2="80" y2="234"/>
  <text class="dg-s" x="80" y="178" text-anchor="middle">burst arrives</text>
  <rect class="dg-box key" x="84" y="198" width="110" height="30" rx="6"/>
  <text class="dg-t" x="139" y="218" text-anchor="middle">data</text>
  <text class="dg-s" x="420" y="218" text-anchor="middle">both round trips skipped</text>
</svg>
<figcaption>Grant-based access spends two request/grant round trips before most of a burst moves. If the gNB knows when the burst is coming and how big it is, it can schedule the grant in advance and skip both.</figcaption>
</figure>

The alternative, **grant-free access**, pre-allocates uplink resources to the phone in every slot. Latency drops, but the resources sit idle whenever there is nothing to send, and the approach does not scale with many users. So operators choose between keeping devices waiting and wasting spectrum.

Predicting traffic breaks that trade-off: allocate just the right amount, just in time. Prior work on cellular traffic prediction mostly looked at minutes to days, for planning and load balancing. The few real-time systems we know of handle periodic traffic with payloads of a few hundred bytes or less, or need a GPU and tens of milliseconds per inference. We wanted bursty, non-periodic, real-application traffic: video, AR, games, video calls, industrial control. Predicted at millisecond granularity, on a CPU.

## The gNB doesn't see the traffic

The first obstacle is that the gNB never observes what actually arrives at the phone. It sees SRs, BSRs and decoded payloads (SDUs), all shaped by the protocol configuration, the scheduler and the channel:

- **One burst becomes many events.** A burst that doesn't fit in one slot's grant is fragmented into several SDUs and triggers several BSRs. Change only the channel bandwidth, 40 to 60 MHz, and the same 35 KB burst produces a completely different sequence.
- **BSRs are quantized.** A BSR reports a buffer *level*, not a byte count: anything from 3910 to 5446 bytes reports as index 20. Subtract consecutive reports and you invent "ghost arrivals" of data that never existed.
- **Retransmissions move things in time.** A transport block that fails decoding shows up at the gNB later than it was sent.

Train a predictor on this raw view and it learns the network's quirks rather than the application.

## Traffic trains

Our answer is an abstraction we call a **traffic train**. The gNB first derives arrivals from pairs of consecutive BSRs and the SDUs received in between, then groups closely spaced arrivals into one train, ended by a configurable idle gap (the *train detection threshold*, a few UL slots). Short thresholds suit URLLC slices whose bursts fit in a slot; longer ones aggregate eMBB bursts that span several.

A few details make trains robust:

- **Size from the lowest BSR.** A train's size is the SDUs delivered up to its final BSR, plus that BSR, minus the last BSR before the train. The final BSR is the smallest level seen, so quantization error is minimized. And since size estimation is decoupled from detection, a train can be closed early, for timely prediction, without waiting for the rest of its SDUs.
- **SRs open trains early.** An SR after an idle period starts a provisional train, timed at the SR, before any BSR arrives.
- **HARQ as ground truth for time.** HARQ remembers the slot of each transmission's first attempt. When a retransmitted SDU finally decodes, SAGE puts it back where it belongs: it can create a train that was missed, correct an existing train's time or size, or merge two trains a lost packet had split.

The result is a sequence of burst-level events that tracks what the application sent, not how the RAN happened to carry it. That matters for accuracy (in a micro-benchmark on mobile AR and SLAM, predictors trained on trains were much more accurate than ones trained on raw derived arrivals) and for portability: with two national operators' configurations we measured 3.2–4.1× lower latency than grant-based access *without retraining any model*.

## One small model per traffic profile

The second obstacle is diversity. A single universal predictor big enough for every application is too slow for millisecond deadlines and expensive to retrain each time a new application shows up, and retraining it for a new profile can degrade the old ones.

SAGE instead keeps a **traffic-aware model database** of small, profile-specific predictors. Each profile is keyed by a 16-number fingerprint, eight statistics (mean, median, IQR, 10th and 90th percentile, skewness, MAD, lag-1 autocorrelation) of inter-arrival times and eight of sizes. A new user's trains are fingerprinted and matched to the nearest profile; the lookup scales to 10,000 profiles in 200 ms on an Intel NUC. The predictors in our evaluation are LSTMs of 3,490 to 50,818 parameters. Predictors are plug-ins, so a profile can use anything from EWMA to a transformer; in our comparison, modern learned predictors performed similarly to each other and consistently beat EWMA.

## The control loop

SAGE spans the gNB, a real-time RIC co-located with it, a near-real-time RIC and the model database. A new user goes through five stages:

1. **Traffic characterization.** The user starts in ordinary grant-based or grant-free mode while the gNB records its trains. The near-RT RIC tests the series for stationarity; if it is predictable, it retrieves the matching model.
2. **Model verification.** The model predicts in the shadows and the gNB scores it against the trains that actually arrive.
3. **Prediction and scheduling.** Once verified, the user switches to *prediction mode*. The gNB pre-allocates resources over a window around the predicted slot, asymmetric because bursts start at the predicted slot and spill forward: fewer resources before it, more after. The window widens when predictions start missing and shrinks when they are good, with two thresholds for hysteresis.
4. **Continual learning.** If verification fails, the model is fine-tuned online, one epoch per new train, and re-verified.
5. **Database update.** If that still fails, the near-RT RIC trains a new model on a longer series and registers it as a new profile.

Traffic that stays unpredictable falls back to grant-based or grant-free access, and for grant-free an analytical latency/resource model picks the guaranteed grant size at the knee of the trade-off curve. Prediction is used when it's reliable, suspended when it isn't, and improved over time.

The real-time parts are cheap. On a single thread of an AMD Ryzen 7 7840HS, inference averages **0.051 ms** and a continual-learning step **0.451 ms**. Against an average inter-arrival time of 59.4 ms across our applications, one thread fits over a thousand inferences between consecutive trains.

## Results

We built SAGE on srsRAN, with Open5GS as the core and our own RICs, all containerized. The gNB and RT RIC run on a Dell Precision 5860 with a USRP X410 radio, band n78, and the UEs are commercial 5G modules. Every experiment is over the air. The applications: surveillance video, mobile AR, SLAM on a mobile robot, Counter-Strike 2, Google Meet, WhatsApp video calls, an industrial-control trace and a SCADA (Modbus/TCP) trace.

<div class="table-wrap">

| Scenario | Uplink latency vs. grant-based | Resources vs. grant-based |
| --- | --- | --- |
| Eight applications, one UE each (average) | 2.53× lower | 1.59× |
| Ten concurrent commercial UEs, four applications | 1.42–2.41× lower | 1.15–1.55× |
| Two national operators' configurations | 3.2–4.1× lower | 1.4–1.5× |

</div>

A few findings worth calling out:

- **Averages don't work for bursty traffic.** Granting a 2 Mbps application its average rate is about 500 bytes per slot, nowhere near a 40 KB burst. Granting 4× the average still loses on latency and wastes resources while idle. SAGE matches the grant-free baselines on latency with up to 37.5× fewer resources.
- **Bigger grants can be slower.** For small-payload traffic (Counter-Strike 2, industrial control, SCADA), oversized grants get filled with MAC padding that both ends must process, so even "full grid" grant-free loses to a right-sized grant. Below about 0.1 Mbps, SAGE can even use *fewer* resources than grant-based access, whose fixed SR grant (512 bytes in srsRAN) over-allocates for tiny packets.
- **It holds up with many users.** With ten UEs from four vendors, Jain's fairness index stayed above 0.99 under both proportional-fair and round-robin schedulers; SAGE submits its grants through the operator's existing MAC scheduler rather than replacing it. Fixed equal-share grant-free sometimes did worse than grant-based, because a burst larger than its reservation queues even while other UEs' reservations sit idle.
- **It holds up on bad channels.** Up to 20% BLER, SAGE stayed close to full-grid grant-free on latency while using resources close to grant-based. Saturating the uplink with best-effort traffic in another slice left SAGE's latency essentially unchanged.
- **Timing matters more than size.** Median arrival-time error was under 4 ms, median size error under 20%. The prediction window absorbs size errors; a missed slot is what costs latency.
- **Applications feel it.** For streamed video, per-frame network latency fell 2.07–2.54×, and end-to-end display latency 1.13–1.23×.

The cost is honest: in steady state, SAGE over-provisions by a constant factor (the ~1.6× above), which reduces how many users a cell carries before airtime saturates compared with pure grant-based access. The paper's appendix models that overhead as a function of user count and bitrate, so an operator can decide per slice where it's worth paying.

## Where this fits

SAGE continues a line of work with the same group on what latency open 5G can actually deliver: [*Ultra-Reliable Low-Latency in 5G: A Close Reality or a Distant Goal?*](https://doi.org/10.1145/3696348.3696862) (HotNets '24), [*Towards URLLC with Open-Source 5G Software*](https://doi.org/10.1145/3750718.3750743) (OpenRIT6G '25), and [*LatencyScope*](https://arxiv.org/abs/2511.21277), a system-level model of 5G RAN latency. The recurring lesson is that the slow parts are protocol and scheduling, not the radio's raw speed.

That's also why it pairs with our [M2SDR and OCUDU work](/blog/m2sdr-ocudu/). There, the job was to make an open radio keep exact time, so the gNB's timeline can be trusted. SAGE works one layer up: once the timeline is trustworthy, the scheduler can stop waiting for the phone to ask.

Open directions from the paper: better train detection under long SR periods, adding channel prediction to size grants and windows, and coordinating predictions across slices.

**Read more:** the [paper](https://doi.org/10.1145/3789240.3829112) (open access, CC BY 4.0) and the [project page at EPFL](https://sens.epfl.ch/research/sage).

*Authors: Aoyu Gong and Raphael Cannatà (co-first authors), Arman Maghsoudnia, Néstor Lomba Lomba and Haitham Hassanieh (EPFL), and Dan Mihai Dumitriu (Pavonis).*
