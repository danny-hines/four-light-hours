# Asset sources

Every file in `assets/` and `bar/refs/` comes from a public-domain U.S. government source (NASA, JPL, USGS)
or from Natural Earth / the Yale Bright Star Catalogue, which are public domain. Raw downloads are kept
unmodified in `assets-src/raw/<item>/` (about 3.2 GB, mostly USGS mosaics; safe to delete once the outputs
exist, and not meant to be committed). Scripts are in `assets-src/scripts/`, run as
`python -I <script> <paths>` from that folder:

| Script | Produces |
| --- | --- |
| `process_earth.py ../raw ../../assets` | `assets/earth/*` |
| `process_bodies.py ../raw ../../assets [body ...]` | moon, mars, mercury, io, europa, ganymede, callisto, triton, jupiter, `assets/height_ranges.json` |
| `build_stars.py ../raw/stars_bsc5/ybsc5.gz ../raw/stars_bsc5/BSC5 ../../assets/sky` | `assets/sky/*` |
| `process_refs.py ../raw ../../bar/refs` | `bar/refs/*.jpg` |

NASA material is not copyrighted (NASA Images and Media Usage Guidelines). You can't use the NASA
insignia or logotype, and nothing can imply NASA endorsement. Credit lines are given below as a courtesy.
USGS Astrogeology products are listed as "public domain" in their FGDC metadata (`accconst`).

## Map conventions (all `assets/<body>/*.webp`)

- Equirectangular (plate carrée), 2:1, **north up, east longitude increasing to the right**.
- **Longitude 0 is at the horizontal centre (u = 0.5)**, so the left edge is 180° W (-180° E) and the right
  edge is 180° E. Row 0 is +90° latitude. Pixel *i* covers longitude -180 + 360·i/W .. -180 + 360·(i+1)/W.
- Sources whose native layout ran 0..360° E (Mercury DEM, Mars MOLA, Europa, Ganymede, Callisto) were rolled by
  half a width so that every output has the same layout. West-positive sources (Io, Europa, Callisto) still have
  east on the right, so they were not mirrored.
- In three.js with the default `SphereGeometry` UVs and `flipY = true`, this puts longitude 0 on +X and
  90° E on -Z, so the map is not mirrored.
- WebP has no single-channel mode. The grayscale maps (`night`, `height`, `clouds`, `water_mask`, Europa, Callisto)
  decode as RGB with R = G = B, so read `.r`.
- **Height maps** are 8-bit and linear. The Moon, Mars and Mercury maps are normalised to the full 0..255 range:
  `height_km = min_km + (v / 255) * (max_km - min_km)`, with the ranges below, which are also in
  `assets/height_ranges.json`. The ranges are measured after resampling, so single-pixel extremes are slightly
  smoothed. The Earth height map uses a different, fixed scale (see Earth).

| Body | min_km | max_km | Reference surface |
| --- | --- | --- | --- |
| Moon | -8.8134 | +10.6398 | LOLA, sphere of radius 1737.4 km |
| Mars | -8.2469 | +21.1491 | MOLA MEGDR, GMM3 areoid |
| Mercury | -10.7250 | +9.0735 | USGS MESSENGER DEM v2, sphere of radius 2439.4 km |
| Earth | 0 (sea level and all ocean) | 6.4 | BMNG/GEBCO land topography, v/255 × 6400 m |

Resampling: a box (area-average) prefilter, then Lanczos to the exact target extent, in float.
No-data pixels (value 0 in every band) in the USGS mosaics are left out of the averages, and holes are filled
with a smooth multi-scale (push-pull) interpolation. The filled areas are listed per body below.

---

## Earth (`assets/earth/`)

| Output | Size | Source | Notes |
| --- | --- | --- | --- |
| `day.webp` (q88) | 4096×2048 | **Blue Marble: Next Generation w/ Topography and Bathymetry, July 2004**, `world.topo.bathy.200407.3x5400x2700.jpg`. URL: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-topography-bathymetry/july/world.topo.bathy.200407.3x5400x2700.jpg (page: https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/base-topography-bathymetry/). Credit: NASA Earth Observatory (Reto Stöckli), MODIS data. | No clouds. Shaded relief on land, bathymetry shading at sea. Native -180..180, 0 at centre. Northern-summer snow cover. |
| `night.webp` (q90, gray) | 4096×2048 | **Earth at Night (Black Marble) 2016, grayscale**, `BlackMarble_2016_3km_gray_geo.tif` (13500×6750). URL: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144897/BlackMarble_2016_3km_gray_geo.tif. Credit: NASA Earth Observatory (Joshua Stevens), Suomi NPP VIIRS data (Miguel Román, NASA GSFC). | City lights only, on pure black, with no moonlit terrain. Tint it in the shader. |
| `height.webp` (lossless) | 2048×1024 | **BMNG Topography**, `gebco_08_rev_elev_5400x2700.tif`. URL: https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/topography/gebco_08_rev_elev_5400x2700.tif (page: https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/topography-bathymetry-maps/). Credit: Jesse Allen, NASA Earth Observatory, using GEBCO data (BODC). | Land only, **0..255 = 0..6400 m linear**, all ocean = 0. Land heights above 6400 m clip at 255. |
| `clouds.webp` (q90, gray) | **2048×1024 (native)** | **Blue Marble (2002) cloud layer**, `cloud_combined_2048.tif`. URL: https://assets.science.nasa.gov/content/dam/science/esd/eo/content-feature/bluemarble/images/cloud_combined_2048.tif (page: https://science.nasa.gov/earth/earth-observatory/the-blue-marble-true-color-global-imagery-at-1km-resolution/). Credit: NASA GSFC / Earth Observatory (Reto Stöckli, Robert Simmon), MODIS. | 2048×1024 is the largest version still published, so I didn't upscale it to 4096. RGB is averaged to gray. The polar areas come from thermal IR, so the Antarctic and Greenland ice sheets show up bright, like cloud. You may want to damp clouds over ice. |
| `water_mask.webp` (lossless) | 2048×1024 | **Natural Earth** (public domain) vector data: `ne_10m_land.geojson`, `ne_50m_lakes.geojson`, `ne_50m_antarctic_ice_shelves_polys.geojson`. URLs: https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_10m_land.geojson (and the same path for `ne_50m_lakes`, `ne_50m_antarctic_ice_shelves_polys`). | **White = water** (ocean and large lakes), black = land and Antarctic ice shelves. Rasterised with PIL at 4× (8192×4096), then box-reduced, so coastlines are anti-aliased. 65.9% of pixels are water. Checked against `day.webp` and `night.webp`. |

Downloaded but not used: `BlackMarble_2016_3km.jpg` (the colour version, which includes moonlit terrain; https://assets.science.nasa.gov/content/dam/science/esd/eo/images/imagerecords/144000/144898/BlackMarble_2016_3km.jpg),
`gebco_08_rev_bath_5400x2700.tif` (BMNG bathymetry, -8000..0 m; same folder as the topography, under `/bathymetry/`),
`ne_50m_land.geojson`.

## Moon (`assets/moon/`)

Source: **NASA SVS 4720 "CGI Moon Kit"** (https://svs.gsfc.nasa.gov/4720), Ernie Wright (USRA), NASA GSFC Scientific
Visualization Studio, from LRO LROC WAC and LOLA data. NASA, public domain.

| Output | Size | From | Notes |
| --- | --- | --- | --- |
| `color.webp` (q88) | 2048×1024 | `lroc_color_poles_4k.tif` (4096×2048, the 2019 colour map with the poles filled). URL: https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/lroc_color_poles_4k.tif | Centred on 0°, as published. |
| `height.webp` (lossless) | 2048×1024 | `ldem_16.tif` (5760×2880 float32, km relative to 1737.4 km). URL: https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720/ldem_16.tif | **-8.8134 .. +10.6398 km** mapped to 0..255. Centred on 0°. |

## Mars (`assets/mars/`)

| Output | Size | Source | Notes |
| --- | --- | --- | --- |
| `color.webp` (q88) | 4096×2048 | **USGS Astrogeology, Mars Viking Global Color Mosaic 925 m** (`Mars_Viking_ClrMosaic_global_925m.tif`, 23059×11530, plus `_pds3.lbl`). URL: https://planetarymaps.usgs.gov/mosaic/Mars_Viking_ClrMosaic_global_925m.tif (served from https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/...). Credit: NASA/JPL/USGS. Public domain. | Built from about 1000 Viking Orbiter red and violet filter images. The colour is synthesised, with a saturated orange-red tone and blue-grey dark albedo features, and the polar caps are bright. Native -180..180 E, 0 at centre. |
| `height.webp` (lossless) | 2048×1024 | **MGS MOLA MEGDR, 16 px/deg** `megt90n000eb.img` (5760×2880, big-endian int16, metres), plus `.lbl`. URL: https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.img. NASA PDS Geosciences Node (MOLA team, D. E. Smith, GSFC). Public domain. | Native 0..360 E, rolled 180°. **-8.2469 .. +21.1491 km** relative to the areoid. Checked against Olympus Mons and Hellas. |

## Mercury (`assets/mercury/`)

| Output | Size | Source | Notes |
| --- | --- | --- | --- |
| `color.webp` (q88) | 2048×1024 | **USGS, Mercury MESSENGER MDIS Basemap MD3 Color Mosaic, Global 665 m** (`Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m.tif`, 23040×11520). URL: https://planetarymaps.usgs.gov/mosaic/Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m.tif. Credit: NASA/JHUAPL/Carnegie Institution of Washington; USGS Astrogeology. Public domain. | The 1000/750/430 nm filters are shown as R/G/B. This is the closest to natural colour of the global products, still mildly stretched. The "EnhancedColor" basemap is much more false-colour. 3.2% no-data, mostly in the rows nearest both poles, filled smoothly. Native -180..180, 0 at centre. Caloris checked at 162.7° E, 31.5° N. |
| `height.webp` (lossless) | 2048×1024 | **USGS Mercury MESSENGER Global DEM 665 m v2** (`Mercury_Messenger_USGS_DEM_Global_665m_v2.tif`, int16 metres). URL: https://planetarymaps.usgs.gov/mosaic/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif. Credit: USGS Astrogeology (Becker et al. 2016), MESSENGER MDIS. | Native 0..360 E, rolled 180°. Values ≤ -30000 are treated as no-data. **-10.7250 .. +9.0735 km**. |

## Galilean moons, Triton (USGS Astrogeology global mosaics; public domain)

All from `https://planetarymaps.usgs.gov/mosaic/<file>` (served from `https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/<file>`), each with its `<file>_pds3.lbl`.

| Output | Size | Source file | Notes |
| --- | --- | --- | --- |
| `io/color.webp` (q88) | 2048×1024 | `Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif` (11445×5723). Galileo SSI violet/green/756 nm colour merged with Voyager. NASA/JPL/USGS. | West-positive, centred on 0 with east on the right, so it was used as-is. The USGS metadata says the colour is **enhanced, and Io's true colour is "similar but much more muted"**, so desaturate in the shader if you want realism. 0.14% no-data (north-pole row) filled. Pele (255° W) and Loki (309° W) checked. |
| `europa/color.webp` (q88, gray) | 2048×1024 | `Europa_Voyager_GalileoSSI_global_mosaic_500m.tif` (19631×9816, grayscale). | Native 0..360 (west-positive, centre 180), rolled 180°. **Grayscale only.** USGS has no global colour Europa mosaic. 4.4% no-data south of about 83° S, filled with smooth gray. |
| `ganymede/color.webp` (q88) | 1024×512 | `Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif` (11520×5760, colour). | Native 0..360 E, rolled 180°. 3.7% no-data (north of about 86° N, plus slivers) filled. Galileo Regio, Osiris and Tros checked. |
| `callisto/color.webp` (q88, gray) | 1024×512 | `Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif` (15138×7569, grayscale). | Native 0..360 (west-positive, centre 180), rolled 180°. **Grayscale only.** 4.0% no-data (south-polar patches) filled. Asgard checked at 140° W. |
| `triton/color.webp` (q88) | 1024×512 | `Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif` (14138×7069). Voyager 2, NASA/JPL/USGS. | -180..180 E, 0 at centre. The colour is synthetic, from orange/violet/UV filters shown as R/G/B, so it reads slightly green. **Voyager imaged only the southern hemisphere: everything north of about 13° N (38.6% of the map) is a smooth fill extrapolated from the data edge, not data.** Dark speckle along the data edge (max channel < 16) was also treated as no-data. |

## Jupiter (`assets/jupiter/cassini.webp`)

| Output | Size | Source | Notes |
| --- | --- | --- | --- |
| `cassini.webp` (q88) | 2048×1024 | **PIA07782 "Cassini's Best Maps of Jupiter: Cylindrical Map"** (3601×1801). URL: https://images-assets.nasa.gov/image/PIA07782/PIA07782~orig.jpg (page: https://science.nasa.gov/photojournal/cassinis-best-maps-of-jupiter-cylindrical-map/). Credit: NASA/JPL/Space Science Institute. | From the 750 nm and 451 nm images of Dec. 11–12, 2000, with colours "close to those the human eye would see". Planetocentric latitude, 360° of longitude. **The caption doesn't state the longitude origin, so the map was used as-is, not rolled.** The Great Red Spot sits at about u = 0.375, v = 0.61. Fine as a base for a procedural band shader. Polar regions are hazy and less detailed. |

## Sun

Nothing downloaded; the Sun is procedural.

## Star catalogue (`assets/sky/`)

Source: **Yale Bright Star Catalogue, 5th revised ed.** (Hoffleit & Warren 1991; ADC/CDS catalogue V/50), as distributed by
the Harvard-Smithsonian CfA Telescope Data Center. Public domain.

- `ybsc5.gz`: the ASCII ADC catalogue (gzip-compressed text, decompressed in memory by `build_stars.py`). http://tdc-www.harvard.edu/catalogs/ybsc5.gz, with the format in http://tdc-www.harvard.edu/catalogs/ybsc5.readme
- `BSC5`: the binary J2000 catalogue, used only to cross-check positions. Maximum difference: 0.00 arcsec over all stars. http://tdc-www.harvard.edu/catalogs/BSC5
- VizieR (vizier.cds.unistra.fr) TLS handshakes failed from this machine, so the Harvard copy of the same V/50 data was used.

| Output | Contents |
| --- | --- |
| `stars.bin` (145,540 bytes) | Little-endian: `uint32 count` (9096), then per star `float32 ra` (rad, J2000), `float32 dec` (rad, J2000), `float32 vmag`, `float32 b_v`. HR order. The 14 HR entries with no position are skipped. 310 stars with no B-V get 0.6. |
| `stars.json` | `{count: 9096, minMag: -1.46, maxMag: 7.96, layout, endianness, units, order, bvMissingCount, bytes, examples[]}`. The examples are Sirius, Vega, Betelgeuse, Polaris and Rigel, each with its index into the file, RA/Dec in degrees, V and B-V, for testing a decoder. |
| `star_names.json` | 60 stars (the 57 navigational stars plus Polaris, Castor and Mimosa) as `{name, hr, ra, dec (rad), vmag, bayer}`, sorted by brightness. Names are the traditional/IAU proper names. Each name was matched to the catalogue by its Bayer designation and constellation; for multiple stars (α Cen, α Cru, α Lib, θ Eri) the brighter component is used. |

Example values (from `stars.json`): Sirius RA 101.2871°, Dec -16.7161°, V -1.46. Vega 279.2346°, +38.7836°, 0.03.
Betelgeuse 88.7929°, +7.4069°, 0.50. Polaris 37.9529°, +89.2642°, 2.02. Rigel 78.6346°, -8.2017°, 0.12.

---

## Reference photographs (`bar/refs/`, not shipped)

All come from the NASA Image and Video Library (`https://images-assets.nasa.gov/image/<id>/<id>~orig.<ext>`), except
the Sun images, which come from the SDO website. All are JPEG q90 with the long edge at most 1600 px. See `bar/refs/INDEX.md`
for what each one shows.

| Output | Source ID / URL | Credit | Processing |
| --- | --- | --- | --- |
| `sun_sdo.jpg` | https://sdo.gsfc.nasa.gov/assets/img/latest/latest_2048_0304.jpg (AIA 304 Å, 2026-11-03 08:08 UT) | NASA/SDO and the AIA science team | resized from 2048 |
| `sun_sdo_aia171.jpg` | https://sdo.gsfc.nasa.gov/assets/img/latest/latest_2048_0171.jpg (AIA 171 Å, 2026-11-03 08:06 UT) | NASA/SDO and the AIA science team | resized |
| `sun_sdo_hmi_visible.jpg` | https://sdo.gsfc.nasa.gov/assets/img/latest/latest_2048_HMIIC.jpg (HMI intensitygram, 2026-11-03 ~08:10 UT) | NASA/SDO and the HMI science team | resized |
| `mercury_messenger.jpg` | PIA15160 "Mercury Globe: 0°N, 0°E" | NASA/JHUAPL/Carnegie Institution of Washington | resized from 2147 (monochrome) |
| `venus_mariner10_or_akatsuki.jpg` | PIA23791 "Venus from Mariner 10" (2020 reprocessing) | NASA/JPL-Caltech | left (natural, non-contrast-enhanced) panel cropped, 1096×1096 |
| `earth_bluemarble_apollo17.jpg` | AS17-148-22727 | NASA/JSC (Apollo 17 crew) | resized from 4579 |
| `earth_iss_limb_night.jpg` | iss062e103874 (Mar. 20, 2020) | NASA/JSC (ISS Expedition 62) | resized from 5568×3712 |
| `moon_full.jpg` | iss008e08451 (Dec. 10, 2003) | NASA/JSC (ISS Expedition 8) | 1000×1000 native-res crop around the disc |
| `moon_full_apollo17.jpg` | AS17-152-23311 (Dec. 19, 1972) | NASA/JSC (Apollo 17 crew) | resized from 3016×3000 |
| `mars_viking_or_rosetta_osiris_truecolor.jpg` | PIA00407 "Global Color Views of Mars" (Viking) | NASA/JPL/USGS | resized from 6787 |
| `jupiter_juno_or_cassini.jpg` | PIA04866 "Cassini Jupiter Portrait" | NASA/JPL/Space Science Institute | resized from 1920×2400 |
| `jupiter_io_shadow_hubble.jpg` | GSFC_20171208_Archive_e000795 "Hubble Captures Rare Triple-Moon Conjunction" (Jan. 24, 2015) | NASA, ESA, and the Hubble Heritage Team (STScI/AURA) | as-is, 1000×1000. Released by NASA (public domain); ESA/Hubble's own copies of Hubble images are CC BY 4.0, so keep the full credit line. |
| `saturn_cassini_equinox.jpg` | PIA11667 "The Rite of Spring" (equinox mosaic, Aug. 2009) | NASA/JPL/Space Science Institute | resized from 7227×3847 |
| `saturn_cassini_backlit.jpg` | PIA08329 "In Saturn's Shadow" (Sept. 2006) | NASA/JPL/Space Science Institute | resized from 2766×1364 |
| `uranus_voyager2.jpg` | PIA18182 "Uranus as seen by NASA's Voyager 2" | NASA/JPL-Caltech | resized from 1720 |
| `neptune_voyager2.jpg` | PIA01492 (Voyager 2 green+orange filter full disc) | NASA/JPL | resized from 2188×2185 |
| `milkyway_eso_or_nasa.jpg` | PIA26718 "Goldstone's DSS-15 Antenna and the Milky Way" (Sept. 2025) | NASA/JPL-Caltech | resized from 1980×3000 PNG |
| `pale_blue_dot_revisited.jpg` | PIA23645 "Pale Blue Dot Revisited" | NASA/JPL-Caltech | full frame, resized from 5230×5175 (Earth is sub-pixel at this size) |
| `pale_blue_dot_revisited_crop.jpg` | PIA23645 | NASA/JPL-Caltech | 1200×800 native-res crop centred on Earth (source pixel 3111, 2685) |

---

## Neptune piece: Triton re-processing (`assets/triton/color.webp`, `assets/triton/mask.webp`)

Script: `assets-src/scripts/process_triton.py ../raw ../../assets` (run as `python -I`). It **replaces** the earlier
1024×512 `triton/color.webp` from `process_bodies.py`.

| Output | Size | From | Notes |
| --- | --- | --- | --- |
| `triton/color.webp` (q90) | 2048×1024 | `raw/triton_usgs/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif` (USGS/LPI PIA18668, Voyager 2 ISS; public domain) | Same layout as above (-180..180 E, 0 at centre). Pixels with max channel < 16 are no-data. The no-data area (north of ~13° N, ~39% of the map) is a heavily smoothed extrapolation, not data. **Colour is rebuilt to approximate true colour**: luminance from the orange+violet mean, hue from the UV/violet ratio and orange/violet slope, mapped onto a pale peach (cap) / bluish-white (fresh N2 frost) / grey-tan palette. This is an artistic reconstruction, not a calibrated product. |
| `triton/mask.webp` (lossless) | 512×256 | same | R = Voyager coverage fraction (1 = real data), G = local sharpness of the source (high-pass energy), B = 0. The shader uses it to hand over to procedural terrain where the mosaic is absent or coarse. |

Neptune itself, its rings and the Adams arcs are fully procedural (no downloaded data). Physical parameters used in
code, from the literature: zonal wind profile (Sromovsky et al. 1993, Icarus 105), GDS / Scooter / DS2 drift periods
(Smith et al. 1989, Science 246; Sromovsky et al. 1993), GDS shape oscillation (~8 d), ring radii/optical depths
(Porco et al. 1995; de Pater et al. 2005, 2018), Adams-arc mean motion 820.1185°/day and the post-2005 fading of
Liberté/Courage (de Pater et al. 2005, 2018), Neptune colour (Irwin et al. 2024, MNRAS 527).

## Mercury piece (`assets/mercury/`, rebuilt by `assets-src/scripts/mercury_assets.py`)

No new downloads: everything is derived from the two USGS rasters listed under "Mercury" above
(`raw/mercury_usgs/…MD3Color_Mosaic_Global_665m.tif`, `raw/mercury_dem_usgs/…DEM_Global_665m_v2.tif`); the script caches
a 4096x2048 float working copy. Run: `python -I mercury_assets.py ../raw ../../assets [work_dir]`.
The earlier generic outputs `color.webp` / `height.webp` were moved to `raw/mercury_prev_outputs/` (not shipped).
All global maps first get a latitude-dependent longitude blur (`polar_iso`) so texels are isotropic on the sphere
(no starburst at the poles). Total about 1.19 MB.

| Output | Size | Notes |
| --- | --- | --- |
| `albedo.webp` (q82, gray) | 2048×1024 | Relative normal albedo: `rel = lo + v/255·(hi−lo)`, lo/hi in `meta.json` (0.40/2.60). Brightness = 0.75·G(750 nm) + 0.25·B(430 nm); the per-band stretch is undone with a DN offset of 55 (round 2; was 80) so LRM is about 0.55 and the brightest rays 2.2–2.5 of the median. Poleward of 64–80° the mosaic (baked grazing-light shading, junk rows) fades to a clipped low-pass. Unsharp mask 0.6 at σ = 1.6 px (4096 scale). |
| `tint.webp` (lossless) | 512×256 | Natural-colour tint, sRGB, linear rgb = 2·texel. From the log(1000/430 nm) slope index relative to the median (DN offset 80), blurred σ = 10 px at the 4096 scale and kept at ~12 % strength (round 2: no WebP macroblocks, weaker LRM blue). |
| `dem.webp` (lossless, gray) | 1664×832 | DEM v2, unsharp-masked (0.45 at σ = 1.4 px of 4096) to restore rim crests, stored as cubic B-spline **coefficients** (separable inverse [1 4 1]/6 filter; longitude wraps, latitude mirrors): `v -> min_km + v/255·(max_km−min_km)` (range in `meta.json`; the DEM itself spans −10.7 .. +9.4 km), relative to the 2439.4 km sphere. |
| `density.webp` (q90, gray) | 512×256 | Crater-density factor 0.3..1 from DEM roughness (|DEM − blur| smoothed to ~200 km), polar band set to 0.85. |
| `detail.webp` (q82, gray) | 512×512 | Tileable real-data detail: 1024×1024 px of the 665 m/px mosaic centred 50° W 0° N (681 km), Moisan periodic component, log-ratio high-pass against a 10 px gaussian, tanh-compressed, downsampled to 512. DN offset 55 like the albedo. Applied triplanar where the global albedo is magnified, at 1x, 1/4 and 1/16 scale. |
| `meta.json` | | Encodings and ranges for the files above. |

## Uranus piece (no shipped assets; everything is procedural)

| Data | Source | Used for |
| --- | --- | --- |
| `raw/uranus_moons_horizons/horizons_70{1..5}.txt` | **JPL Horizons API** (https://ssd.jpl.nasa.gov/api/horizons.api), `EPHEM_TYPE=VECTORS`, `CENTER=500@799` (Uranus body centre), `REF_SYSTEM=ICRF`, `REF_PLANE=FRAME`, `TLIST=2026-11-02 12:00 UT`, one file per moon (701 Ariel, 702 Umbriel, 703 Titania, 704 Oberon, 705 Miranda). NASA/JPL-Caltech Solar System Dynamics, public domain. | Position/velocity vectors copied into `src/bodies/uranus/orbits.js`: each moon's orbital plane (r × v, so Miranda keeps its real 4.4° inclination) and its exact phase at that epoch. Radii and periods come from `BODIES`. |

Physical parameters used in code (from the literature, no downloads): ring radii, eccentricities, apsidal rates,
widths and optical depths (French et al. 1991, "Dynamics and structure of the Uranian rings", in *Uranus*, U. Arizona
Press; Esposito & Colwell; Voyager 2 RSS/PPS occultations), dust-band layout after the Voyager 2 172° phase image
(PIA00142); Uranus zonal-wind profile (Sromovsky et al. 2015, Icarus 258); limb-darkening/colour fit to the Voyager 2
reference (PIA18182) and Karkoschka's full-disc albedo spectrum; seasonal north polar cap and convective "popcorn"
features (HST OPAL / Keck, Sromovsky et al. 2015); Uranian-satellite albedos, sizes and named-feature coordinates
(Voyager 2; IAU/USGS Gazetteer of Planetary Nomenclature, planetocentric east longitude).
Fix round 1 (literature only, no downloads): moon photometry is Hapke (1981/2002) IMSA with w solved per channel to the
Karkoschka (2001) geometric albedos (Ariel 0.53, Titania 0.35, Oberon 0.31, Miranda 0.32, Umbriel 0.26), B0 = 1,
h = 0.045, HG b = -0.3, plus a lunar-Lambert-style facet term (McEwen 1991); simple-to-complex crater transition
~15-25 km (Schenk 1989); extended stratospheric haze tau ~ 0.01 (Pollack et al. 1987).
Fix round 2: Voyager 2 moon images downloaded as **visual references only** (not shipped, not used as textures), to
compare the procedural moon surfaces against: `raw/uranus_moon_refs/PIA{18185,01490,00044,00140,00141}.jpg` (Miranda:
global views, the chevron / Inverness, Elsinore, Arden), `PIA01534.jpg` and `PIA00041.jpg` (Ariel), `PIA00039.jpg`
(Titania), `PIA00034.jpg`, `PIA18184.jpg`. NASA/JPL-Caltech Photojournal, public domain, fetched from
`https://assets.science.nasa.gov/content/dam/science/psd/photojournal/pia/<pia##>/<pia#####>/PIA#####.jpg`.
Literature for the 2026 cap shape: HST WFC3 2022 and JWST NIRCam 2023 Uranus images (north polar cap edge near
60-62 N with a darker lane just outside it).

## Venus piece (no shipped assets, no downloads; everything is procedural)

Physical parameters used in code (from the literature): cloud-top (τ = 1) altitude ~68-70 km, cloud-top and upper-haze
scale heights and optical depths, poleward thickening of the upper haze and detached haze layers near 90-95 km
(Venus Express SPICAV/SOIR and VMC limb studies, e.g. Wilquet et al. 2009, Luginin et al. 2016); mode-2 H2SO4
droplets r ≈ 1.05-1.2 µm with asymmetry ~0.7 and the cloud-top glory (Markiewicz et al. 2014, Icarus 234); visible
spectral albedo of the cloud deck (Mallama et al. 2017 photometry); UV morphology — horizontal Y, bright polar
collar/bands, mid-latitude spiral streaks, subsolar convective cells, high-latitude gravity waves (Pioneer Venus
OCPP, Venus Express VMC, Akatsuki UVI; Titov et al. 2012, Piccialli et al. 2014); zonal super-rotation ~100 m/s,
~4-day equatorial period, near-constant wind to ~50° (Sánchez-Lavega et al. 2008, Horinouchi et al. 2017);
night-side 735 K surface thermal glow in the visible (Parker Solar Probe WISPR, Wood et al. 2022). IAU rotation
elements come from `src/core/astro.js`. Reference image: `bar/refs/venus_mariner10_or_akatsuki.jpg` (see above).

---

## Milky Way (`assets/sky/milkyway.webp`, `dust.webp`, `milkyway.json`) and nebulae (`nebulae.webp`, `nebulae.json`) — sky piece

Optical-band reconstruction of the Milky Way from NASA all-sky infrared surveys (public domain, NASA/GSFC LAMBDA)
plus the Lynds optical dark-cloud catalogue (NASA HEASARC). Built by `assets-src/scripts/build_milkyway.py`
(helpers `dirbe_common.py`, `healpix_lite.py`, `votable_lite.py`):
`python -I build_milkyway.py ../raw ../../assets/sky [cache_dir] [preview_dir]` (env `RES_R=2.5 DUST_Q=70` as shipped).

| Raw file (`assets-src/raw/`) | Source | Credit |
| --- | --- | --- |
| `sky_dirbe/DIRBE_BAND1A_ZSMA.FITS` (1.25 um), `BAND07` (60 um), `BAND08` (100 um), `BAND10` (240 um) | https://lambda.gsfc.nasa.gov/data/cobe/dirbe/zsma/ — COBE/DIRBE Zodi-Subtracted Mission Average maps (quad-cube, ecliptic J2000; also downloaded `BAND2A`, unused) | NASA/GSFC, COBE Science Working Group |
| `sky_iras_issa/ISSA_B4H0_healpix_ns1024.fits` | https://lambda.gsfc.nasa.gov/data/foregrounds/iras_issa/ — IRAS Sky Survey Atlas 100 um, HCON 0, HEALPix Nside 1024 (galactic, NESTED) | NASA/JPL-Caltech/IPAC (IRAS), HEALPix version by LAMBDA |
| `sky_darkclouds/ldn_heasarc.xml` | NASA HEASARC TAP, table `ldn` (`https://heasarc.gsfc.nasa.gov/xamin/vo/tap/sync?REQUEST=doQuery&LANG=ADQL&QUERY=SELECT * FROM ldn`): Lynds' Catalogue of Dark Nebulae (Lynds 1962, ApJS 7, 1), 1791 clouds north of Dec -33 with position, area and opacity class 1-6 (factual catalogue data) | B. T. Lynds; NASA HEASARC |
| `sky_darkclouds/lbn_heasarc.xml` (+ `lbn_doc.html`) | NASA HEASARC table `lbn`: Lynds' Catalogue of Bright Nebulae (Lynds 1965, ApJS 12, 163) — the red (POSS colour class 3-4) nebulae of brightness class 1-4 mark HII regions whose own warm far-IR dust is kept out of the foreground screen | B. T. Lynds; NASA HEASARC |

Processing: COBE quad-cube pixels located with the published COBE forward CSC polynomial (face orientation
verified by seam continuity), HEALPix NESTED with the standard ang2pix; dust column from DIRBE (large scales) + IRAS
at full resolution (0.0625 deg grid; near the plane, compact < 0.7 deg far-IR peaks, which are warm sources, are
suppressed by an oriented line opening that keeps filaments; inside LBN / hand-listed southern HII regions the 100 um
excess over a ~3 deg lower envelope is removed from the foreground screens), DIRBE 100/240 um temperature correction, E(B-V) = 0.0184 I100 (Schlegel, Finkbeiner & Davis
1998 calibration constant), R_V = 3.1; the LDN clouds stamped into the foreground screen as irregular steep-edged
shapes of their catalogued area, with A_V by opacity class (0.4 ... 2.6 mag, diluted for clouds below 0.25 deg);
LDN clouds laid along the local filament direction (structure tensor of the IRAS column); explicit Coalsack (RA 193,
Dec -62.8, ~7 x 5 deg, A_V ~1.6) and Pipe Nebula / B72 screens (positions of B59, B65-67, B77/78 from Barnard's list);
documented bright star-cloud windows (Large Sgr cloud, Baade's window, M24, Scutum, Norma, Cygnus) where the nearer
dust is thinned; J-band starlight with BSC5 stars masked;
a near / mid / far layered extinction model. Outputs (galactic, l = 0 at the centre increasing to the left, latitude
stretched as b = 90 sinh(2.6 y)/sinh(2.6)): `milkyway.webp` 1024x256 RGB = smooth ln tau_eff, log background
starlight S_bg, reddening fraction rho; `dust.webp` 4096x1024 grey = ln tau_eff residual at IRAS resolution. The
renderer applies the extinction per pixel. The raw files (~127 MB) are not shipped.

`nebulae.webp` (512x384 atlas) is authored procedurally by `assets-src/scripts/build_nebulae.py` (shapes in
`nebula_shapes.py`) from the documented morphology of M42/M43/NGC 1977, M8, M20, NGC 3372, NGC 7000/IC 5070/LDN 935,
the rho Oph complex, the Rosette and the LMC — no imagery is used.

--- | --- | --- |
| `sky_dirbe/DIRBE_BAND1A_ZSMA.FITS` (1.25 um), `BAND07` (60 um), `BAND08` (100 um), `BAND10` (240 um) | https://lambda.gsfc.nasa.gov/data/cobe/dirbe/zsma/ — COBE/DIRBE Zodi-Subtracted Mission Average maps (quad-cube, ecliptic J2000; also downloaded `BAND2A`, unused) | NASA/GSFC, COBE Science Working Group |
| `sky_iras_issa/ISSA_B4H0_healpix_ns1024.fits` | https://lambda.gsfc.nasa.gov/data/foregrounds/iras_issa/ — IRAS Sky Survey Atlas 100 um, HCON 0, HEALPix Nside 1024 (galactic, NESTED) | NASA/JPL-Caltech/IPAC (IRAS), HEALPix version by LAMBDA |

Processing: COBE quad-cube pixels located with the published COBE forward CSC polynomial (face orientation
verified by seam continuity), HEALPix NESTED with the standard ang2pix; dust column from DIRBE (large scales) + IRAS
(< 0.6 deg), DIRBE 100/240 um temperature correction, E(B-V) = 0.0184 I100 (Schlegel, Finkbeiner & Davis 1998
calibration constant), R_V = 3.1; J-band starlight with BSC5 stars masked; a layered extinction model gives the
optical radiance. Output: galactic coordinates, l = 0 at the centre increasing to the left, latitude stretched as
b = 90 sinh(2.6 y)/sinh(2.6); RGB = log-encoded linear radiance, A = log-encoded foreground tau_V.
The raw files (~127 MB) are not shipped.

---

## Saturn (`assets/saturn/`)

| Output | Size | Source | Processing |
| --- | --- | --- | --- |
| `rings_tau.bin` (152 KB) | 76,001 samples, 1 km apart, 66,000-142,000 km | **Voyager 2 PPS delta Scorpii ring occultation, 1 km resampled profiles** (PDS volume VG_2801, data set `VG2-SR/UR/NR-PPS-2/4-OCC-V1.0`, files `EASYDATA/KM001/PS1P0107.TAB` ... `PS1P0114.TAB` with their `.LBL`). URL: https://pds-rings.seti.org/holdings/volumes/VG_28xx/VG_2801/EASYDATA/KM001/ . Credit: NASA/JPL, Voyager PPS team (L. W. Esposito et al.), PDS Ring-Moon Systems Node. NASA, public domain. Raw files in `assets-src/raw/saturn_rings_pps/` (3.5 MB). | `assets-src/scripts/process_saturn_rings.py ../raw/saturn_rings_pps ../../assets/saturn --plot ../../shots/saturn/profile.png`. Column 4 (normal optical depth at 0.264 um). Opaque samples (99) -> tau 5. A noise-adaptive, uncertainty-weighted smoother (3-9 km) is applied only where the signal is weak relative to the 1-sigma limits, so edges and ringlets survive. Negative tau -> 0. In the B ring, where the PPS saturates near tau ~ 3 and 1 km noise dips are not real gaps, smooth floors from Cassini UVIS/RSS occultations are applied (B2 1.9, B3 core 4.2, B4 2.2; PPS structure kept above them). The D ring (< 74,400 km, not constrained by the occultation) is replaced by a dusty model (tau ~1e-3 with the D68/D72/D73 ringlets); the Roche division beyond the A-ring edge gets tau ~1e-4; the F ring is removed (it is eccentric and modelled analytically in `src/bodies/saturn/rings.js`). Format: 16-byte header `'SRTP', uint32 count, float32 r0_km, float32 dr_km`, then little-endian uint16 tau x 10000. |

Everything else for Saturn is computed at runtime: the globe, haze, ring particle properties (albedo/colour/dust fraction by
region), spokes, the F, G and E rings, ringshine and all six moons are procedural. The moons' mean longitudes at J2000 come
from the JPL SSD planetary satellite mean elements (https://ssd.jpl.nasa.gov/sats/elem/sep.html, Laplace-plane elements,
epoch 2000-01-01.5: L = node + peri + M) and are written as constants in `src/bodies/saturn/moons.js`.

---

## Jupiter piece additions

- **Galilean moon orbital phases**: JPL Horizons API (public, NASA/JPL Solar System Dynamics), Jupiter-centred
  (`CENTER='500@599'`) ecliptic J2000 state vectors of 501-504 at JD 2461347.0 and 2461357.0 (2026-11-02/12 12:00 UTC),
  https://ssd.jpl.nasa.gov/api/horizons.api. Only the derived phase constants are shipped (in `src/bodies/jupiter/moons.js`);
  the vectors and the fit are in `assets-src/scripts/jupiter_moon_phases.mjs`.
- **Zonal wind profile** (`src/bodies/jupiter/flow.js`): tabulated from the published Voyager/Cassini cloud-tracking profiles
  (Limaye 1986; Porco et al. 2003, Science 299, 1541; Garcia-Melendo et al. 2011). No files downloaded.
- `assets/ganymede/color.webp`, `assets/callisto/color.webp`: re-made at **2048x1024** from the same USGS mosaics with
  `process_jupiter_moons.py` (same resampling and conventions as `process_bodies.py`).
- `assets/europa/color.webp`: re-made from the same USGS mosaic with `process_europa_equalize.py`. It equalises the
  strip-to-strip high-pass contrast and damps the mid band, which hides the strip seams between differently
  processed Voyager and Galileo strips. The broad albedo pattern and the lineae are kept.
- `assets/jupiter/turb_c1.webp`, `turb_c2.webp`, `turb_u.webp`, `turb_v.webp`, `turb_meta.json` (fix round 1): **no
  external data**. These are the output of a physics simulation run in this project. A pseudo-spectral 2-D
  Navier-Stokes solver forced at k = 14 with two passive tracers held against mean gradients
  (`assets-src/scripts/jupiter_turbulence.py`, seed 20261102). It spins up at 512² and is refined to 1024². The raw
  outputs are in `assets-src/raw/jupiter_turb/`. `assets-src/scripts/jupiter_turb_post.py` applies a k^-0.5 amplitude
  tilt above the forcing scale and encodes the files. Re-run with
  `python -I jupiter_turbulence.py ../raw/jupiter_turb 1024 12`, then
  `python -I jupiter_turb_post.py ../raw/jupiter_turb ../../assets/jupiter 0.5`.
- `assets/jupiter/structure.webp`: derived from `cassini.webp` (PIA07782) by `assets-src/scripts/jupiter_structure.py`.
  It measures the local relative RMS of the longitude-only high-pass luminance, i.e. where the real planet has
  non-zonal turbulence.

## Asteroids (`src/bodies/asteroids/*`)

No downloaded data and no files in `assets/`. Every rock shape, crater, boulder, colour and the whole swarm
are generated in code from seeded hashes at load time. The belt ring uses published statistics only:
Kirkwood-gap locations at the 4:1, 3:1, 5:2, 7:3, 9:4 and 2:1 mean-motion resonances with Jupiter, Rayleigh
eccentricity and inclination spreads, the Hilda 3:2 resonance and the Trojan L4/L5 clouds. Composition
classes use typical geometric albedos from the literature (C ~0.05-0.09, S ~0.17-0.29, M ~0.12-0.19,
V ~0.30-0.40). Hero rotation periods are the published values for the analogues (Eros 5.27 h, Itokawa
12.13 h, Ida 4.63 h, Didymos 2.26 h, Vesta 5.34 h). Photometry follows the lunar-Lambert model (McEwen 1991)
and the Lommel-Seeliger disc integral.

---

## HUD fonts (`src/ui/fonts-data.js`, not under `assets/`)

The HUD's two typefaces are the only non-public-domain material in the project. Both are licensed under the
**SIL Open Font License 1.1**, which allows embedding and redistribution with the copyright notice; the licence texts
are kept in `assets-src/raw/fonts_google/OFL-Jost.txt` and `OFL-Cormorant.txt`, and the closing credits name both.

| Output | Source | Licence |
| --- | --- | --- |
| `JOST` in `fonts-data.js` (base64 of 26,576 bytes) | Jost variable (wght 200–600), Google Fonts latin subset, `https://fonts.gstatic.com/s/jost/v20/92zatBhPNqw73oTd4g.woff2` (via `https://fonts.googleapis.com/css2?family=Jost:wght@200..600`). © 2020 The Jost Project Authors (https://github.com/indestructible-type/Jost). | SIL OFL 1.1 |
| `CORMORANT_ITALIC` in `fonts-data.js` (base64 of 39,260 bytes) | Cormorant Garamond Italic variable (wght 400–600), Google Fonts latin subset, `https://fonts.gstatic.com/s/cormorantgaramond/v21/co3ZmX5slCNuHLi8bLeY9MK7whWMhyjYrEtImSo.woff2`. © 2015 The Cormorant Project Authors (github.com/CatharsisFonts/Cormorant). | SIL OFL 1.1 |

Raw files: `assets-src/raw/fonts_google/` (the two `.ttf` files there were downloaded only to inspect the OpenType
features, e.g. Jost's `tnum` tabular figures, and are not shipped). Rebuild: `python -I build_hud_fonts.py
../raw/fonts_google ../../src/ui/fonts-data.js` from `assets-src/scripts/`.

## Earth piece, round 2: continental-shelf map (`assets/earth/shelf.webp`)

Script: `assets-src/scripts/process_earth_shelf.py ../raw ../../assets` (run as `python -I`). Source: the BMNG/GEBCO
bathymetry already downloaded above (`earth_topo/gebco_08_rev_bath_5400x2700.tif`, 8-bit, 0..255 = -8000..0 m;
credit Jesse Allen, NASA Earth Observatory, using GEBCO data). Output 2048x1024 lossless gray (170 KB):
v = 255 * clamp(1 - depth / 200 m, 0, 1) at sea, 255 on land. The shader uses it for shallow-shelf water colour and
computes the deep-ocean colour itself (the Blue Marble's bathymetry-shaded ocean shows mid-ocean ridges as light lines).
- `assets/jupiter/turb_z.webp` (fix round 3): **no external data**. It is the output of a beta-plane 2-D turbulence
  simulation run in this project (`assets-src/scripts/jupiter_turb_beta.py`, seed 20261103, beta 160, k_f 28, 1024^2).
  Forced turbulence on a beta plane organises itself into zonal jets, so its tracers are zonal streaks and wave trains.
  Raw outputs are in `assets-src/raw/jupiter_turb_beta/`. Re-run with
  `JB_BETA=160 JB_AMP=0.22 JB_MU=0.02 JB_KF=28 JB_TFINE=1.2 python -I jupiter_turb_beta.py ../raw/jupiter_turb_beta 1024 28`,
  then `JB_Q=74 python -I jupiter_turb_beta_post.py ../raw/jupiter_turb_beta ../../assets/jupiter 0.12 0.6 0.4`.
- `assets/europa/color.webp` (fix round 3): re-made from the same USGS mosaic with `process_europa_v3.py`. A
  structure-tensor coherence filter keeps the lineae and drops the tile-dependent stucco texture, then the local amplitude
  is compressed and the mid band damped. This replaces the `process_europa_equalize.py` output.
