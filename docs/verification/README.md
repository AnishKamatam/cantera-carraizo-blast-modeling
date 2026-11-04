# Verification Record

What has been checked in the blast models, against what, and what remains open. Audited 2026-11-03 against the code at commit `b204d6c`, plus the corrections listed below. Yang & Kavetsky (1990), Moore & Richards (2005), McKenzie (2018) and the NIOSH and Bureau of Mines reports were read directly and have tests in `test/sourcePapers.test.js` or `test/researchAudit.test.js`. Sources still needed are in the [reading list](reading-list.md).

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
| Borehole pressure | Primary (Iverson & Hustrulid 2011) | Wall value and decoupling **corrected** |
| Powder factor | Secondary | Capsule **corrected**; it is a local charge concentration |
| Specific explosive energy | No source found | **Open:** reads about 2.7× above ANFO's published energy, so it is an index, not energy |
| Detonation simulator | Blair 2008 unverified | **Open:** overrun primer can delay arrival; `computePrimerAwareEm` breaks its own invariant |

### Flyrock

| Model | Evidence | Verdict |
|---|---|---|
| Richards & Moore | Primary for Moore & Richards (2005), the source report; the 2004 paper is paywalled | Matches: reproduces its k values, charge per metre, launch speeds and heights; `m` is kg per metre in its worked values, though its legend says per delay |
| Lundborg | Primary as stated by McKenzie (2018) and Moore & Richards (2005); originals unread | Matches: 260 and about 40 × Dia^(2/3) in inches and metres |
| McKenzie | Primary for the 2018 slides; 2009 and 2022 unread | Within about 3% of the slides' rounded constants (9.74 vs 10, 3 vs 3.1); velocity fit and FoS × range match |
| Roth | Primary (Roth 1979) | Core equations match; **open:** omits the paper's rock-specific corrections, so reads high |
| Ballistics with drag | Hand check; secondary | Matches |
| Shroud mesh | Hand check | Safety factor **corrected** |
| Burial depth at a point | No source found | **Open:** not the published form; `sim/run.js` uses the per-hole form |
| Risk bands | Primary (Chiappetta chart in McKenzie 2018, partly obscured) | Thresholds **corrected** to the chart |

### Movement

| Model | Evidence | Verdict |
|---|---|---|
| Kinematic launch | Primary (Yang & Kavetsky 1990, journal pages 23–26 missing from our scan); "Yang 2020 3DMuck" couldn't be traced and is removed | Eq 8–14 match by integration; **open:** see below |
| Sphere DEM | Hand check | Free fall, range, rebound, momentum match; **open:** friction isn't Coulomb |
| Displacement | Hand check | Centre of mass right; `swellEmergent` **corrected** |

## Known open issues

These aren't fixed, in rough order of importance.

1. **DEM friction isn't Coulomb.** A block at 20 m/s slides about 0.8 m, where Coulomb friction gives about 40.8 m. The fitted Pe of about 1.5 may partly compensate, which hasn't been separated out. To be solved in the GPU DEM.
2. **The launch model differs from Yang & Kavetsky (1990) beyond Eq 8–14.** Removing the repo's steering cuts throw from 15.2 m to 2.0 m, so these differences dominate results:

   | Topic | Paper | Repo |
   |---|---|---|
   | Confinement | Eq 15–17: `exp(-C1 D)` to the nearest free face, with C1 = 0.2 | Unsourced relief steering (`cSteer`, with a factor of 0.6) |
   | Delay | Eq 18: `exp(-Pd n / Td)`, with Pd = 0.01 in its case study | 40 ms timing window |
   | Explosive strength | Eq 21: Pe scales with the square root of density | Linear in density, and in hole diameter squared |
   | Attenuation | b = 2 Pr − 1; its case study has Pr = 1.35, so b = 1.7 | Default b = 1.5 |
   | Transport | A block stops where it lands | Sphere DEM |
   | Calibration | Eq 20: fit Pe, Pr and Pd to muckpile heights at each site | Fits Pe to centre-of-mass throw |

   The paper's Pe (55 for ANFO, 69.6 for HEF) isn't comparable with the repo's Pe, because the units differ. The GPU DEM should implement the paper's terms. Refitting the JS model would change every throw result, so it is left as is and labelled.

   **Fitting heights, as Eq 20 says, doesn't fix the muckpile.** Across 20 settings of Pe and b on SWELLFACTOR ([results](../../results/swellfactor-shape-fit.json)), RMS height error stays between 6.0 and 8.6 m, and the surface stays 4.4–5.8 m too low whichever setting is used. The best setting, Pe 3 and b 2.0, gives 26 m of throw. The defaults score 6.3 m RMS. A low bias that doesn't respond to launch strength points away from the launch model, and toward transport, swell or how the surface is built. This hasn't been traced yet.

3. **Blair-Minchinton far from the charge.** A fixed bandwidth reads about 7.8× below the site law at 100 m, and multi-hole sums use a scalar radial axis.
4. **Fast Heelan models aren't waveform models.** They read 2.2–15.7× above time-domain results, so use them for comparison only. HeelanOriginal also ignores deck mass.
5. **`ForwardArray` and `SeedSynthesis`.** Love-wave spreading (about 10× low at 1 km), non-transverse S waves, impossible default velocities, and a single-seed path with no travel time. Not used by the Carraizo pipeline.
6. **Signature deconvolution.** Reconstruction can read 0.998 while true recovery is near zero.
7. **Holmberg-Persson under about 1.5 m.** Eight elements err by up to about 43% at 0.3 m. Touching decks with different primer times also stay separate.
8. **Roth, burial-depth point form, jointed-rock joints, SEE.** Unsourced or incomplete, as above.
9. **Run settling and trench rock.** See `settled`, `restFraction` and `belowOriginalGroundFraction` in results.

## Source notes

- **Moore & Richards (2005) Table 2:** its 75° rows reproduce from its Eq 7, but its 45° rows at 10 m and 20 m don't (81.6 and 63.9 m printed, 83.6 and 66.3 m calculated). Its Eq 8 also shows a sin 2θ factor that its Eq 1 and Eq 9 don't support.
- **Citations that couldn't be traced:** "Anderson 1989" and "Yang 2020". The "Holmberg & Persson 1979" paper is also cited as 1978 and 1980.

## Test strength

[results/mutation-summary.json](../../results/mutation-summary.json) records how many deliberate formula breaks the tests catch: 263 of 592 (44%) before the audit corrections, and 281 of 595 (47%) after them. Damage (4 of 24), pressure (14 of 36) and signal (41 of 96) are the weakest. Breaks are sampled per file and some don't change behaviour, so treat the figures as indicative. Tests added after that run, in `test/sourcePapers.test.js`, aren't included.
