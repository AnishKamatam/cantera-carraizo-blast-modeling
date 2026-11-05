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

### Fragment size (Kuz-Ram)

`src/movement/Fragmentation.js`, used by the DEM with `sizeModel: "kuzram"`. Tests: `sim/test/fragmentation.test.js`.

**This is an uncalibrated estimate and is not for safety decisions.** No fragment size has been measured at Carraizo or for SWELLFACTOR, so the curve is unverified at both. Rock factor, explosive strength and drilling error are assumptions, and the rock type at Carraizo is unconfirmed.

Cunningham's papers (1983, 1987, 2005) weren't read: the 2005 paper was found only on Scribd and on a vendor site with no stated permission, so neither was opened. Every equation below is therefore Secondary. The primary source to obtain is Cunningham 2005, EFEE Brighton proceedings, pp. 201–210.

| Item | Form used | Evidence | Check |
|---|---|---|---|
| Median size | x50 (cm) = A K^-0.8 Q^(1/6) (115/RWS)^(19/20) | Secondary: Jug et al. 2017, Agyei & Asssua 2022, Adebola et al. 2016 Eq 6 (as the 2005 form) | Hand check. K ratios reproduce Adebola Table 2 within 0.2% |
| Strength exponent | 19/20 by default; `rwsExponent` takes 19/30 | **Sources differ:** 19/30 in Adebola Eq 1, Saadoun et al. 2022 and Agyei's KCO form, as the earlier form | Moves x50 by about 11% at RWS 83 |
| Powder factor exponent | -0.8 | Secondary. Jug Eq 1 prints +0.8, which is taken as a misprint: Adebola's table only fits -0.8 | As above |
| Uniformity index | n = (2.2 - 14 B/d) sqrt((1 + S/B)/2) (1 - W/B) (abs(BCL - CCL)/L + 0.1)^0.1 (L/H), B in m, d in mm | Secondary: Jug Eq 3, Agyei Eq 3, the 1987 form. Adebola Eq 5 adds a pattern factor (1.1 staggered), left out here | Hand check. The B, S and d terms reproduce all 15 rows of Jug Table 1 within 1.5%, at W = 0. W, BCL, CCL and L/H terms have no table check |
| Passing curve | R(x) = exp(-0.693 (x/x50)^n) | Secondary: Jug Eq 2, Agyei Eq 2, Adebola Eq 2a | Reproduces Jug Table 1 shares within 0.5 points |
| Timing terms A_T, C(A), C(n) | Left at 1 | Judgement: no data to set them | None |
| Charge above grade for Q, K and L | Default; `chargeBasis: "total"` for the whole charge | Secondary: Adebola and Agyei, restating the 2005 paper's "excluding sub drill". Adebola Eq 3 calls L the drilled length, and Jug and Agyei the charge length | See the sensitivities below |
| Single-charge term | BCL = L, CCL = 0 | Judgement | The term is then 1.01; an equal two-deck charge would give 0.79 |
| K | Charge over the rock simulated | Judgement: a break zone isn't burden x spacing x bench | Block B on the pattern volume: K 1.89, x50 about 18 cm |
| Top size | Smaller of burden and spacing | Secondary: Mutinda et al. 2021, for KCO | Rosin-Rammler itself has no top size |

The mixture of a 2005 x50 and a 1987 n is the one Jug et al. and Agyei & Asssua use, not a form Cunningham states. Ouchterlony (2015, abstract only) notes that the median was substituted for Kuznetsov's mean. That hasn't been corrected here.

**Assumptions, fixed before any simulation result was seen.** The author had already done rough sums at A of 10 and 22, so this isn't a fully blind choice.

| Input | Low (finest) | Central | High (coarsest) | Source |
|---|---|---|---|---|
| Rock factor A | 4 | 7 | 13 | 4: Jug et al. 2017 limestone, 4.0 then 3.8 calibrated. 5.0 in Agyei & Asssua 2022. 7: Mohamed et al. 2019 limestone, 7.14; Jug Fig 3 spans 5.0–8.6. 13: a web calculator's top "hard" value, Unverified. Published range 0.8–22 |
| RWS, ANFO = 100 | 120 | 83 | 83 | 83: Riomex 8000 in Agyei & Asssua 2022 (80% emulsion, 1.2 g/cm³), printed as "relative weight energy". 120: web calculator, Unverified |
| Drill error W | 0.3 m | 0.3 m | 0.3 m | Adebola et al. 2016 Table 1, another site |

Bulk emulsion or an emulsion-rich blend is assumed, because the scenario's assumed 1.24 g/cm³ is too dense for plain ANFO. A USGS Geolex entry, seen only as a search excerpt because the page refused the fetch, places the Carraizo Breccia's type locality in a quarry in Barrio Carraizo (volcanic breccia). The Trujillo Alto Limestone is another candidate unit in the area. Whether either is this site is unconfirmed. The A sources are mostly limestone, so none is known to fit.

**Predicted sizes.** Unverified at both shots. Oversize is the share of rock retained.

| Shot | Case | K kg/m³ | Q kg | x50 cm | n | Over 0.5 m | Over 1 m | Over 2 m |
|---|---|---|---|---|---|---|---|---|
| Block B | Low | 1.19 | 1,085 | 10.7 | 1.63 | 0.02% | 0.00% | 0.00% |
| Block B | Central | 1.19 | 1,085 | 26.7 | 1.63 | 14.5% | 0.25% | 0.00% |
| Block B | High | 1.19 | 1,085 | 49.5 | 1.63 | 49.4% | 11.3% | 0.12% |
| SWELLFACTOR | Low | 1.65 | 449 | 7.1 | 1.38 | 0.00% | 0.00% | 0.00% |
| SWELLFACTOR | Central | 1.65 | 449 | 17.7 | 1.38 | 5.4% | 0.05% | 0.00% |
| SWELLFACTOR | High | 1.65 | 449 | 32.8 | 1.38 | 28.9% | 3.9% | 0.02% |

Both designs have powder factors above those of the cases read (about 0.4–1.0 kg/m³), so these are extrapolations. In blast 1 of Agyei & Asssua 2022, image analysis found a smaller median than Kuz-Ram and no rock above 0.8 m where Kuz-Ram predicted 2.6%, so the upper tail can overstate boulders. Their blast 2 agreed much better, so this is one example and not a correction.

**How it reaches the DEM.** Rock finer than a grid cell can't be resolved and stays as lumps. Their radii keep the old `sizeVariationPct` scatter, which has no link to the blast. Rock whose volume is nearest 2 or more cells becomes one sphere at the cluster's mass-weighted centre, with baseRad cubed adding up, so mass and solid volume are conserved. A cell's screen size is taken as its edge (judgement). A boulder is made only when the curve holds that much rock. Boulders start small enough to clear their neighbours, and grow after launch. Positions are unbiased: no source read gives an amount for the stemming zone or the back of the blast. A boulder takes the same bulking growth as a lump, so its drawn sphere holds about 0.86 of its rock volume at swell 1.43 (judgement: it keeps the pile's bulk correct).

**What it does to results.**

| Run (Coulomb, mu 0.5) | Cell m | Blocks | Boulders | Largest | Throw m | Bearing | Rest | Sphere RMSE |
|---|---|---|---|---|---|---|---|---|
| Block B, no sizes | 1.0 | 21,918 | | | 17.63 | 88.5 | 0.999 | |
| Block B, central | 1.0 | 21,912 | 6 | 2 cells | 17.63 | 88.6 | 0.999 | |
| Block B, high | 1.0 | 21,057 | 585 | 10 cells | 17.25 | 87.7 | 0.999 | |
| SWELLFACTOR, central seeds 1, 2, 3; high (A 13) seed 1 | 2.2 | 13,193 | 0 | | identical to no sizes | | | 3.53, 3.50, 3.55: identical |
| SWELLFACTOR, A 22, a stress run only, seeds 1, 2, 3 | 2.2 | 13,168 | 22 | 3 cells | 35.05, 34.89, 32.67 | | | 3.57, 3.56, 3.79 |

**The score says nothing about the curve.** At SWELLFACTOR's 2.2 m cell the central and high cases hold no whole boulder, so those runs are the same run. There's no fragment-size data for that shot in any case.

**Sensitivity of Block B central:** boulders are 0 with the whole charge, 1 with exponent 19/30, 2 with W 0.1 and 13 with W 0.5. Treat "6" as "a handful".

**Open:**

1. At the central case a client still sees a nearly uniform pile, because most rock is finer than a 1 m cell. A finer grid or a display-only sampling of the curve would be needed to show it.
2. Not validated against any measured size distribution at either site.

Sources: [Jug et al. 2017](https://iopscience.iop.org/article/10.1088/1755-1315/95/4/042013) (CC BY 3.0); [Adebola et al. 2016](https://www.iiste.org/Journals/index.php/JEES/article/download/30610/31442); [Agyei & Asssua 2022](http://dx.doi.org/10.4314/njt.v41i4.3); [Mutinda et al. 2021](https://www.scielo.org.za/scielo.php?script=sci_arttext&pid=S2225-62532021000300004); [Saadoun et al. 2022](https://pmi.spmi.ru/pmi/article/view/15538?setLocale=en_US); [Mohamed et al. 2019](https://crimsonpublishers.com/amms/fulltext/AMMS.000545.php); [Ouchterlony 2015](https://link.springer.com/article/10.1007/s00603-015-0722-1) (abstract); [web calculator](https://www.diggy.tools/tools/blast-fragmentation-calculator); [USGS Geolex](https://ngmdb.usgs.gov/Geolex/Units/Carraizo_880.html).

### Break zone

`sim/scenario/breakzone.js`, tests in `sim/test/breakzone.test.js`. **Uncalibrated, and not for safety decisions.** No break limit has been measured at Carraizo, whose rock type is unconfirmed.

The threshold and range were fixed from these sources before any comparison with the survey. A coarse map of the surfaces had already been seen, so "before" means before any volume or wall number, not before seeing the site.

**3500 mm/s, range 1850–6500. This is broken rock, not first cracks.** Only K / threshold matters, so the range also covers doubt in K.

| PPV (mm/s) | Meaning | Source | Evidence | Use |
|---|---|---|---|---|
| 700–1000 | New crack formation, Swedish igneous rock | Iverson et al. 2008, quoting Holmberg and Persson | Primary for the citation | Cracked, not broken; not in the range |
| 1850 | Over-break limit, Stillwater drift holes | Iverson et al. 2008 | Primary | Low end |
| 2540 | "Break up of rock mass" | Bauer and Calder, in Singh; dated 1970 in that paper's text and 1978 in its references | Secondary | Run as a sensitivity |
| 3200–4050 | This form's PPV at the Modified Ash pressure radius (Eq 3.11), coupled emulsion, 165–229 mm | Derived from Iverson and Hustrulid 2011 | Derived from primary | Central, 3500 |
| About 6500 | The same at `R_d = 25 r_h`, as for ANFO in a 229 mm hole | Derived | Derived | High end |

- **Limits don't carry across hole size.** With alpha 0.7 and beta 1.5, geometric scaling raises PPV as `s^0.6`, so a limit found at 48 mm rises about 2.5 times at 229 mm (derived).
- **Constants and limit must be paired.** 1850 belongs to K 171, alpha 1.4, beta 1. Those constants on a 284 kg hole give a radius near 250 m, so they can't be used at this scale (derived).
- **1000 mm/s gives 15–21 m radii here.** Iverson et al. call even their small-hole results at that limit "quite high".
- Forsyth 1993 (4 x PPVc) wasn't read, so that multiple isn't relied on.

The burden rule, `B = 2 R_d`, is Iverson and Hustrulid 2011 Eq 3.3 (Primary). The breakout angle, 45° (range 0–60), and the cleaning limits are judgement.

**SWELLFACTOR, no fitting.** 531 holes; surveyed in-situ volume 144,228 m³.

| Case | Volume m³ | Error | Above grade 322 m | Footprint IoU | Wall past survey, median | Back-break, mean |
|---|---|---|---|---|---|---|
| **Central, 3500** | **176,978** | **+22.7%** | **158,666 (+10.0%)** | **0.92** | **+2.8 m** | **5.4 m** |
| Low, 1850 | 199,164 | +38.1% | 175,703 (+21.8%) | 0.79 | +6.4 m | 9.3 m |
| High, 6500 (7 holes choked) | 137,031 | -5.0% | 136,849 (-5.1%) | 0.92 | 0.0 m | 2.7 m |
| Bauer and Calder, 2540 | 187,779 | +30.2% | 166,710 (+15.6%) | 0.86 | +4.3 m | 7.2 m |
| Central, breakout 0° | 160,247 | +11.1% | 157,874 (+9.5%) | 0.92 | +2.8 m | 5.4 m |
| Central, burden rule off | 174,998 | +21.3% | 156,901 (+8.8%) | 0.89 | +2.8 m | 5.4 m |
| Central, 1979 form | 179,951 | +24.8% | 159,833 (+10.8%) | 0.90 | +2.8 m | 5.6 m |

The zone is biased high: its wall lands about 3 m past the survey and its floor about 1.5 m under it. The range is wide, so containing the survey is weak evidence. Breakout 0° and the high threshold score better and weren't adopted, since that would be fitting. Two things about the survey are unconfirmed: the floor, at 322.0–322.5 m, may be a dig floor, which would make +10% the fairer figure; and the unscalloped wall, 2–3 m past the pattern on surfaces named `TRIM_*`, may be a drawn limit rather than a break line.

**Block B** (`block-b-zone`, 24 holes). The hand-cut block was 19,685 m³.

| Threshold mm/s | Volume m³ | Back-break, mean | Choked holes |
|---|---|---|---|
| **3500** | **21,907** | **7.4 m** | 0 |
| 1850 | 43,987 | 13.6 m | 0 |
| 6500 | 3,530 | 2.3 m | 12 of 24 |

The 3,530 m³ is a model limit, not a likely outcome: on 23 m columns 6500 mm/s is close to this form's maximum, about 7100 mm/s on the axis, and half the holes choke. The free face is an assumption, read from terrain shape and not confirmed on site.

**Changed after seeing a result:**

- The burden rule was added after the first SWELLFACTOR run gave zero volume at 6500 mm/s, with every hole choked. It made the central error slightly worse (+21.3% to +22.7%) and removed the cliff.
- The Ash bridge test tolerance went from 15% to 20%, because the long Block B column measured 4050. The central 3500 was kept.
- Test fixtures were corrected: a toe hand value, a larger voxel-fill fixture, and the back-break hand test run with burden rule and rib cleaning off.

**Open:**

1. Collapse is a large assumption. Rock above a broken level is 32% of the SWELLFACTOR volume and 42% of Block B's, from one rule: undercut rock falls.
2. Holes don't add, and the contour has no direction. Holmberg-Persson is isotropic, calibrated on small holes and extrapolated here.

Sources: Iverson, Kerkering and Hustrulid 2008; Iverson and Hustrulid 2011; [Singh, Investigation of Blast Damage and Underground Stability](https://crawler.dep.state.pa.us/Mining/BureauOfMiningPrograms/BMPPortalFiles/Blasting_Research_Papers/UG%20Vibrations/Singh%20-%20Investigation%20of%20Blast%20Damage%20and%20Underground%20Stability.pdf), read for the Bauer and Calder table; the original Bauer and Calder report wasn't read.

## Known open issues

These aren't fixed, in rough order of importance.

1. **Default DEM friction isn't Coulomb.** A block at 20 m/s slides about 0.8 m, where Coulomb friction gives about 40.8 m. The opt-in `contactModel: "coulomb"` fixes this and is tested in `sim/test/transport.test.js`; the default stays as it was, so existing results don't change. Under Coulomb, piles stand too steep (53° repose at friction 0.5 in a small test pile), so treat friction as a model setting.
2. **The launch model differs from Yang & Kavetsky (1990) beyond Eq 8–14.** Removing the repo's steering cuts throw from 15.2 m to 2.0 m, so these differences dominate results:

   | Topic | Paper | Repo |
   |---|---|---|
   | Confinement | Eq 15–17: `exp(-C1 D)` to the nearest free face, with C1 = 0.2 | Unsourced relief steering (`cSteer`, with a factor of 0.6) |
   | Delay | Eq 18: `exp(-Pd n / Td)`, with Pd = 0.01 in its case study | 40 ms timing window |
   | Explosive strength | Eq 21: Pe scales with the square root of density | Linear in density, and in hole diameter squared |
   | Attenuation | b = 2 Pr − 1; its case study has Pr = 1.35, so b = 1.7 | Default b = 1.5 |
   | Transport | A block stops where it lands | Sphere DEM |
   | Calibration | Eq 20: fit Pe, Pr and Pd to muckpile heights at each site | Fits Pe to centre-of-mass throw |

   The paper's Pe (55 for ANFO, 69.6 for HEF) isn't comparable with the repo's Pe, because the units differ. The opt-in `velocityModel: "yang1990"` implements the paper's terms, with tests in `sim/test/launch.test.js`. On `SWELLFACTOR` with Coulomb contact it scores about the same as the existing launch (RMS 3.50–3.75 m against 3.50–3.55 m), with hand-picked Pe 30 and Pd 0.002. On Block B those settings throw implausibly far (1,765 blocks past 100 m), so they don't transfer between sites. The default launch is left as is and labelled.

   **Delay trends run opposite to the paper.** Eq 18 reduces horizontal velocity as inter-row delay shortens, and the paper says shorter delays favour vertical motion. On Carraizo block B the repo's model does the reverse: 25 ms throws further than 42 ms, and 100 ms throws less ([results](../../results/carraizo-block-b.json)). `yang1990` follows Eq 18 at launch and on a synthetic bench. On `SWELLFACTOR`, launch follows the trend but final throw doesn't, so don't use either model to compare delay timings yet.

   **Fitting heights, as Eq 20 says, doesn't fix the muckpile.** Across 20 settings of Pe and b on SWELLFACTOR ([results](../../results/swellfactor-shape-fit.json)), RMS height error stays between 6.0 and 8.6 m, and the surface stays 4.4–5.8 m too low whichever setting is used. The best setting, Pe 3 and b 2.0, gives 26 m of throw. The defaults score 6.3 m RMS. A low bias that doesn't respond to launch strength points away from the launch model, and toward transport, swell or how the surface is built. **Traced:** `maxSwell` scaled sphere volume rather than pile bulk, and spheres fill only 0.518 of a voxel, so piles held 0.77–0.81 of their in-situ volume while reporting 1.40. Centre-binned surfaces also leave holes below about 15,000 blocks. With Coulomb contact and bulk-based growth, bias falls to about -0.5 m ([results](../../results/blast-scale.json)). That gain isn't independent: `packingFraction` 0.60 was derived from a packing of 0.62 measured on SWELLFACTOR, the shot being scored. It wasn't adjusted against the survey, and `sim/test/transport.test.js` also checks bulk on a made-up bench (1.38 against a set 1.40, seed 1), but no second surveyed shot has tested it.

   **Swell under Coulomb is the rock at rest.** `results().swell` and `swellBulk` count only blocks at rest, against the rock those blocks hold, and are null if none is. A block in the air would read as a column of bulk: on SWELLFACTOR with about 6,000 blocks, `yang1990` at its paper defaults read 8.5 at 8 s with 46% at rest, against 1.25 once settled. Stopped early, the figure describes the landed part (1.21 at 8 s), not the whole pile, so read it with `restFraction`. The default contact keeps its old reading.

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
