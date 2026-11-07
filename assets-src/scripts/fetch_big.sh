#!/usr/bin/env bash
# Downloads large public-domain source rasters into per-item raw dirs.
UA="space-animation-v1/1.0 (educational project)"
R=/c/Users/danny/fun/space-animation-v1/assets-src/raw
B=https://asc-pds-services.s3.us-west-2.amazonaws.com/mosaic
SVS=https://svs.gsfc.nasa.gov/vis/a000000/a004700/a004720
get() { mkdir -p "$R/$1"; local out="$R/$1/$(basename "$2")"; if [ -s "$out" ]; then echo "skip $out"; return; fi
  curl -sS -f -L --retry 3 -A "$UA" -o "$out" "$2" -w "%{http_code} %{size_download} $1/$(basename "$2") %{time_total}s\n" || echo "FAIL $2"; }
get moon_svs4720 $SVS/lroc_color_poles_4k.tif
get moon_svs4720 $SVS/ldem_16.tif
get mars_mola_megdr https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.img
get mars_mola_megdr https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/megt90n000eb.lbl
get io_usgs $B/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif
get io_usgs $B/Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km_pds3.lbl
get europa_usgs $B/Europa_Voyager_GalileoSSI_global_mosaic_500m.tif
get europa_usgs $B/Europa_Voyager_GalileoSSI_global_mosaic_500m_pds3.lbl
get ganymede_usgs $B/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif
get ganymede_usgs $B/Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m_pds3.lbl
get callisto_usgs $B/Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif
get callisto_usgs $B/Callisto_Voyager_GalileoSSI_global_mosaic_1km_pds3.lbl
get triton_usgs $B/Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif
get triton_usgs $B/Triton_Voyager2_ClrMosaic_GlobalFill_600m_pds3.lbl
get mars_viking_usgs $B/Mars_Viking_ClrMosaic_global_925m.tif
get mars_viking_usgs $B/Mars_Viking_ClrMosaic_global_925m_pds3.lbl
get mercury_usgs $B/Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m.tif
get mercury_usgs $B/Mercury_MESSENGER_MDIS_Basemap_MD3Color_Mosaic_Global_665m_pds3.lbl
get mercury_dem_usgs $B/Mercury_Messenger_USGS_DEM_Global_665m_v2.tif
get mercury_dem_usgs $B/Mercury_Messenger_USGS_DEM_Global_665m_v2_pds3.lbl
echo ALLDONE
