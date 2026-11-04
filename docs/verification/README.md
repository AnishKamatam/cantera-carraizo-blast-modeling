# Verification Record

What has been checked in the blast models, against what, and what remains open. Audited 2026-11-03 against the code at commit `b204d6c`, plus the corrections listed below.

## Evidence levels

| Level | Meaning |
|---|---|
| **Primary** | The equation was read in the cited source |
| **Secondary** | Taken from a citing paper, textbook or abstract |
| **Hand check** | No source claim: checked by independent calculation |
| **Unverified** | The source could not be obtained, so the code's claim is untested |

Verifying a formula shows the code matches its source. It doesn't show the model predicts Carraizo, because no site measurements exist yet.

**Caution on one source:** Blair & Minchinton (2006) was read from an unlicensed archive copy during the audit. Treat those checks as provisional until repeated against a licensed copy. Its text isn't reproduced here.

## Results by model

"Corrected" means changed during this audit, with a test that failed first.

### Vibration

| Model | Evidence | Verdict |
|---|---|---|
| Site law form and fitting | Primary (USBM RI 6774) | Matches; charge per delay **corrected** |
| Probability of exceedance | Primary for the normal approximation; Blair 2011 unverified | Matches what could be read |
| Radiation patterns, pulse, constants | Provisional primary (Blair & Minchinton 2006) | Match |
| Scaled Heelan and Blair variant | Provisional primary; Blair 2008 Eq 22 unverified | Toe cut-off **corrected**; relabelled, since it is not a waveform model |
| Heelan Original | Provisional primary | Constant matches; toe cut-off **corrected**; **open:** static sum |
| Blair-Minchinton | Provisional primary | Single element matches; increments and time window **corrected**; **open:** multi-hole sum and fixed bandwidth |
| Ripple tank | No source | Matches its own formula only |

### Signal processing

| Model | Evidence | Verdict |
|---|---|---|
| FFT, inter-delay spectrum | Hand check | Match |
| Ricker, Berlage wavelets | Primary (Wang 2015); secondary | Match |
| Detune | Primary (reference code) | Matches |
| Polarisation | Hand check; Flinn 1965 unverified | Maths matches |
| Seed synthesis | Secondary; Blair 2008 unverified | **Open:** missing travel time and damage form |
| Forward array | Secondary, hand check | **Open:** Love spreading, S direction, impossible default velocities |
| Signature deconvolution | Secondary | Division matches; **open:** failure can't be detected |
| Gao correction | Unverified | Arithmetic reproduces |
| Monitor CSV | Secondary; vendor formats unverified | Units **corrected** |

### Damage, pressure and detonation

| Model | Evidence | Verdict |
|---|---|---|
| Holmberg-Persson and NIOSH forms | Primary (Iverson et al. 2008); original papers secondary | Match; **open:** accuracy under about 1.5 m |
| Jointed rock | Secondary for intact rock; joint model unverified | Labelled heuristic; **open:** unsourced joint model |
| Borehole pressure | Primary (Hustrulid & Iverson 2011) | Wall value and decoupling **corrected** |
| Powder factor | Secondary | Capsule **corrected**; it is a local charge concentration |
| Specific explosive energy | No source found | **Open:** reads about 2.7× above ANFO's published energy, so it is an index, not energy |
| Detonation simulator | Blair 2008 unverified | **Open:** overrun primer can delay arrival; `computePrimerAwareEm` breaks its own invariant |

### Flyrock

| Model | Evidence | Verdict |
|---|---|---|
| Richards & Moore | Secondary; paper paywalled | Matches the secondary form |
| Lundborg | Secondary | Matches |
| McKenzie | Primary for 2018 slides only; rest secondary or unverified | Matches, with shape factor fixed at 1.2 |
| Roth | Primary (Roth 1979) | Core equations match; **open:** omits the paper's rock-specific corrections, so reads high |
| Ballistics with drag | Hand check; secondary | Matches |
| Shroud mesh | Hand check | Safety factor **corrected** |
| Burial depth at a point, risk bands | No source found | **Open:** not the published form; `sim/run.js` uses the per-hole form |

### Movement

| Model | Evidence | Verdict |
|---|---|---|
| Yang launch | Unverified; "Yang 2020 3DMuck" couldn't be traced | **Open:** steering term and timing window are unsourced and account for most of the throw |
| Sphere DEM | Hand check | Free fall, range, rebound, momentum match; **open:** friction isn't Coulomb |
| Displacement | Hand check | Centre of mass right; `swellEmergent` **corrected** |

## Known open issues

These aren't fixed, in rough order of importance.

1. **DEM friction isn't Coulomb.** A block at 20 m/s slides about 0.8 m, where Coulomb friction gives about 40.8 m. The fitted Pe of about 1.5 may partly compensate, which hasn't been separated out. To be solved in the GPU DEM.
2. **Launch model can't be checked without Yang & Kavetsky (1990).** `PE_SCALE` and the steering term are local tuning. Removing steering cuts throw from 15.2 m to 2.0 m.
3. **Blair-Minchinton far from the charge.** A fixed bandwidth reads about 7.8× below the site law at 100 m, and multi-hole sums use a scalar radial axis.
4. **Fast Heelan models aren't waveform models.** They read 2.2–15.7× above time-domain results, so use them for comparison only. HeelanOriginal also ignores deck mass.
5. **`ForwardArray` and `SeedSynthesis`.** Love-wave spreading (about 10× low at 1 km), non-transverse S waves, impossible default velocities, and a single-seed path with no travel time. Not used by the Carraizo pipeline.
6. **Signature deconvolution.** Reconstruction can read 0.998 while true recovery is near zero.
7. **Holmberg-Persson under about 1.5 m.** Eight elements err by up to about 43% at 0.3 m. Touching decks with different primer times also stay separate.
8. **Roth, burial-depth point form and risk bands, jointed-rock joints, SEE.** Unsourced or incomplete, as above.
9. **Run settling and trench rock.** See `settled`, `restFraction` and `belowOriginalGroundFraction` in results.

## Sources that would close the most gaps

Yang & Kavetsky 1990; Blair 2008; Holmberg & Persson 1978/79; Richards & Moore 2004; McKenzie 2009 and 2022; a licensed copy of Blair & Minchinton 2006; Heelan 1953. Confirmed references are in [references.bib](../references.bib). "Anderson 1989" and "Yang 2020" could not be found, and need correct citations.

## Test strength

[results/mutation-summary.json](../../results/mutation-summary.json) records how many deliberate formula breaks the tests catch. Before the audit corrections they caught 263 of 592 (44%). A sample of breaks per file was used, so treat the figures as indicative.
