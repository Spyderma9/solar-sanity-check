import { useEffect, useMemo, useRef, useState } from 'react';

const SIZE = 600;
// Zoom is chosen per roof so the whole panel array fits; Static Maps needs an integer.
const MIN_ZOOM = 16;
const MAX_ZOOM = 22;
// Above this, Static Maps silently serves its max available satellite imagery
// (often 20-21) at the WRONG extent, so overlays no longer line up. We never
// request past it — higher zooms upscale the image in CSS instead, which keeps
// the photo and the panel boxes locked together at every zoom.
const IMAGERY_MAX_ZOOM = 20;
// Pixels kept clear around the array (also leaves room for the bottom toolbar)
const FIT_PADDING = 60;

function staticMapUrl(lat, lng, zoom) {
  const key = import.meta.env.VITE_SOLAR_KEY;
  // scale=2 doubles the image resolution (1200px served, displayed at 600)
  return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${SIZE}x${SIZE}&scale=2&maptype=satellite&key=${key}`;
}

// Web Mercator position as a fraction of the world square (0..1 on each axis) —
// the same projection Google Static Maps uses. At zoom z the world square is
// (256 * 2^z) pixels, so fraction * worldSize gives absolute world pixels.
function mercatorFraction(lat, lng) {
  const sin = Math.sin((lat * Math.PI) / 180);
  return {
    x: (lng + 180) / 360,
    y: 0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI),
  };
}

function fractionToLatLng(x, y) {
  return {
    lat: (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI,
    lng: x * 360 - 180,
  };
}

// Projects a lat/lng to pixel coordinates within the SIZE x SIZE image:
// worldPixel(point) - worldPixel(center) + SIZE/2. The zoom must match the
// Static Maps URL or the overlay will drift.
function latLngToPixel(lat, lng, centerLat, centerLng, zoom) {
  const worldSize = 256 * Math.pow(2, zoom);
  const p = mercatorFraction(lat, lng);
  const c = mercatorFraction(centerLat, centerLng);
  return {
    x: (p.x - c.x) * worldSize + SIZE / 2,
    y: (p.y - c.y) * worldSize + SIZE / 2,
  };
}

// Ground meters represented by one pixel at this zoom/latitude (Web Mercator).
function metersPerPixel(centerLat, zoom) {
  return (156543.03392 * Math.cos((centerLat * Math.PI) / 180)) / Math.pow(2, zoom);
}

// Subtle cell-grid pattern so active panels read as solar panels, not blue boxes
const CELL_GRID =
  'repeating-linear-gradient(0deg, transparent 0 5px, rgba(255,255,255,0.18) 5px 6px),' +
  'repeating-linear-gradient(90deg, transparent 0 5px, rgba(255,255,255,0.18) 5px 6px)';

export default function RoofDesigner({
  lat,
  lng,
  panels = [],
  panelWidthMeters,
  panelHeightMeters,
  roofSegments = [],
  activePanelIds = new Set(),
  onTogglePanel,
  onReset,
  isCustomized = false,
  recommendedCount = null,
  imageryDate = null,
}) {
  const [imageStatus, setImageStatus] = useState('loading'); // loading | loaded | error
  const [hoveredId, setHoveredId] = useState(null);
  const [sunView, setSunView] = useState(false); // color panels by production

  // Center the view on the panel array and pick the largest zoom where it all
  // fits inside the frame, so any roof fills the picture without clipping.
  const view = useMemo(() => {
    if (panels.length === 0) return { lat, lng, zoom: MAX_ZOOM };

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const panel of panels) {
      const { x, y } = mercatorFraction(panel.center.latitude, panel.center.longitude);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
    }

    const center = fractionToLatLng((minX + maxX) / 2, (minY + maxY) / 2);
    const span = Math.max(maxX - minX, maxY - minY);
    // Largest zoom where span * 256 * 2^zoom <= SIZE - 2 * FIT_PADDING
    const zoom =
      span > 0
        ? Math.floor(Math.log2((SIZE - 2 * FIT_PADDING) / (256 * span)))
        : MAX_ZOOM;
    return {
      lat: center.lat,
      lng: center.lng,
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)),
    };
  }, [panels, lat, lng]);

  // User zoom on top of the auto-fit zoom, still clamped to what Static Maps serves
  const [zoomOffset, setZoomOffset] = useState(0);
  const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom + zoomOffset));

  // Scroll wheel / trackpad pinch over the picture zooms the map only. This must
  // be a manually-attached non-passive listener: React's onWheel is passive, so
  // preventDefault (which stops the browser's page zoom/scroll) wouldn't work.
  const containerRef = useRef(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let accumulated = 0;
    const onWheel = (e) => {
      e.preventDefault();
      accumulated += e.deltaY;
      // Zoom levels are integers with an image reload each — step only after
      // a decent amount of scroll so trackpads don't fire a burst of requests
      if (Math.abs(accumulated) >= 80) {
        const delta = accumulated < 0 ? 1 : -1;
        accumulated = 0;
        setZoomOffset((offset) =>
          Math.min(MAX_ZOOM - view.zoom, Math.max(MIN_ZOOM - view.zoom, offset + delta))
        );
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [view.zoom]);

  const imgZoom = Math.min(zoom, IMAGERY_MAX_ZOOM);
  const imgScale = Math.pow(2, zoom - imgZoom);
  const mapUrl = staticMapUrl(view.lat, view.lng, imgZoom);

  // A new address/zoom means a new image request — show the spinner again
  const [prevMapUrl, setPrevMapUrl] = useState(mapUrl);
  if (prevMapUrl !== mapUrl) {
    setPrevMapUrl(mapUrl);
    setImageStatus('loading');
  }

  const placed = useMemo(() => {
    const mpp = metersPerPixel(view.lat, zoom);
    // panelHeightMeters is the panel's long side; PORTRAIT = long side vertical
    const portraitW = panelWidthMeters / mpp;
    const portraitH = panelHeightMeters / mpp;

    return panels.map((panel, i) => {
      const { x, y } = latLngToPixel(
        panel.center.latitude,
        panel.center.longitude,
        view.lat,
        view.lng,
        zoom
      );
      const landscape = panel.orientation === 'LANDSCAPE';
      const segment = roofSegments[panel.segmentIndex];
      // Seen from above, lengths along the slope shrink by cos(pitch) — after
      // rotation the panel's height axis runs up the slope, so foreshorten it
      const foreshorten = Math.cos(((segment?.pitchDegrees ?? 0) * Math.PI) / 180);
      return {
        key: i,
        x,
        y,
        w: landscape ? portraitH : portraitW,
        h: (landscape ? portraitW : portraitH) * foreshorten,
        // Align the panel with its roof segment so rows follow the roof lines
        azimuth: segment?.azimuthDegrees ?? 0,
        kwh: panel.yearlyEnergyDcKwh,
      };
    });
  }, [panels, view, zoom, panelWidthMeters, panelHeightMeters, roofSegments]);

  // Production range across the roof, for the sun-view color scale
  const kwhRange = useMemo(() => {
    const values = panels.map((p) => p.yearlyEnergyDcKwh).filter((v) => v != null);
    if (values.length === 0) return null;
    const min = Math.min(...values);
    const max = Math.max(...values);
    return max > min ? { min, max } : null;
  }, [panels]);

  // Bright gold for the sunniest spots down to deep blue for the weakest
  function sunColor(kwh, alpha) {
    const t = (kwh - kwhRange.min) / (kwhRange.max - kwhRange.min);
    return `hsla(${210 - 162 * t}, ${55 + 25 * t}%, ${36 + 16 * t}%, ${alpha})`;
  }

  return (
    <div>
      <h2>Roof Designer</h2>
      <div
        ref={containerRef}
        style={{
          position: 'relative',
          width: SIZE,
          height: SIZE,
          touchAction: 'none',
          border: '1px solid var(--line)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden',
          background: 'var(--card)',
          boxShadow: 'var(--shadow)',
        }}
      >
        {imageStatus === 'loading' && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.75rem',
              color: 'var(--muted)',
            }}
          >
            <div className="roof-spinner" />
            Loading satellite image…
          </div>
        )}
        {imageStatus === 'error' ? (
          <p
            style={{
              position: 'absolute',
              top: '50%',
              width: '100%',
              textAlign: 'center',
              margin: 0,
              color: 'var(--bad)',
            }}
          >
            Could not load satellite image — check that the Maps Static API is enabled for your key.
          </p>
        ) : (
          <div style={{ width: SIZE, height: SIZE }}>
            <img
              src={mapUrl}
              alt="Satellite view of your roof"
              width={SIZE}
              height={SIZE}
              className={imageStatus === 'loaded' ? 'roof-fade-in' : undefined}
              style={{
                display: 'block',
                opacity: imageStatus === 'loaded' ? 1 : 0,
                // Zoom past the imagery cap by scaling about the center — the
                // map is centered on the frame, so geometry stays exact
                transform: imgScale !== 1 ? `scale(${imgScale})` : undefined,
              }}
              onLoad={() => setImageStatus('loaded')}
              onError={() => setImageStatus('error')}
            />
            {imageStatus === 'loaded' &&
              placed.map((p) => {
                const active = activePanelIds.has(p.key);
                const hovered = hoveredId === p.key;
                return (
                  <button
                    key={p.key}
                    type="button"
                    onClick={() => onTogglePanel?.(p.key)}
                    onMouseEnter={() => setHoveredId(p.key)}
                    onMouseLeave={() => setHoveredId(null)}
                    onFocus={() => setHoveredId(p.key)}
                    onBlur={() => setHoveredId(null)}
                    title={`${active ? 'Click to remove panel' : 'Click to add panel'}${
                      p.kwh != null ? ` · ${Math.round(p.kwh)} kWh/yr` : ''
                    }`}
                    aria-pressed={active}
                    aria-label={`Panel ${p.key + 1}`}
                    style={{
                      position: 'absolute',
                      left: p.x - p.w / 2,
                      top: p.y - p.h / 2,
                      width: p.w,
                      height: p.h,
                      padding: 0,
                      transform: `rotate(${p.azimuth}deg)`,
                      backgroundColor:
                        sunView && kwhRange && p.kwh != null
                          ? sunColor(p.kwh, active ? (hovered ? 1 : 0.9) : hovered ? 0.55 : 0.35)
                          : active
                            ? `rgba(16, 42, 92, ${hovered ? 0.92 : 0.8})`
                            : `rgba(37, 99, 235, ${hovered ? 0.3 : 0.08})`,
                      backgroundImage: active ? CELL_GRID : 'none',
                      border: active
                        ? '1px solid rgba(203, 225, 255, 0.9)'
                        : `1px dashed rgba(255, 255, 255, ${hovered ? 0.9 : 0.5})`,
                      borderRadius: 1,
                      boxShadow: hovered ? '0 0 6px rgba(147, 197, 253, 0.9)' : 'none',
                      boxSizing: 'border-box',
                      cursor: 'pointer',
                      transition: 'background-color 0.1s, box-shadow 0.1s',
                    }}
                  />
                );
              })}
          </div>
        )}
        {imageStatus === 'loaded' && imageryDate?.year && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              left: 8,
              padding: '0.15rem 0.5rem',
              borderRadius: 5,
              background: 'rgba(10, 14, 22, 0.72)',
              color: '#fff',
              fontSize: '0.68rem',
              opacity: 0.9,
            }}
          >
            Imagery:{' '}
            {new Date(imageryDate.year, (imageryDate.month ?? 1) - 1).toLocaleString(undefined, {
              month: 'short',
              year: 'numeric',
            })}
          </div>
        )}
        {imageStatus !== 'error' && (
          <div
            style={{
              position: 'absolute',
              top: 8,
              right: 8,
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
            }}
          >
            {[
              { label: '+', delta: 1, disabled: zoom >= MAX_ZOOM },
              { label: '−', delta: -1, disabled: zoom <= MIN_ZOOM },
            ].map(({ label, delta, disabled }) => (
              <button
                key={label}
                type="button"
                onClick={() => setZoomOffset((z) => z + delta)}
                disabled={disabled}
                aria-label={delta > 0 ? 'Zoom in' : 'Zoom out'}
                style={{
                  width: 30,
                  height: 30,
                  border: 'none',
                  borderRadius: 6,
                  background: 'rgba(17, 24, 39, 0.72)',
                  color: '#fff',
                  fontSize: '1.1rem',
                  lineHeight: 1,
                  cursor: disabled ? 'default' : 'pointer',
                  opacity: disabled ? 0.4 : 1,
                }}
              >
                {label}
              </button>
            ))}
          </div>
        )}
        {imageStatus === 'loaded' && panels.length > 0 && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              display: 'flex',
              alignItems: 'center',
              gap: '0.75rem',
              padding: '0.5rem 0.75rem',
              background: 'rgba(17, 24, 39, 0.72)',
              color: '#fff',
              fontSize: '0.875rem',
              backdropFilter: 'blur(2px)',
            }}
          >
            <span>
              <strong>
                {activePanelIds.size} of {panels.length}
              </strong>{' '}
              panels
            </span>
            <span style={{ opacity: 0.75 }}>
              {sunView
                ? 'gold = most sun, blue = least'
                : `click a panel to toggle${
                    recommendedCount != null ? ` · recommended: ${recommendedCount}` : ''
                  }`}
            </span>
            {kwhRange && (
              <button
                onClick={() => setSunView((v) => !v)}
                style={{
                  marginLeft: 'auto',
                  padding: '0.25rem 0.75rem',
                  border: sunView
                    ? '1px solid rgba(255, 205, 90, 0.9)'
                    : '1px solid rgba(255,255,255,0.5)',
                  borderRadius: 6,
                  background: sunView ? 'rgba(242, 169, 59, 0.25)' : 'transparent',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                }}
              >
                ☀ Sun view
              </button>
            )}
            {isCustomized && (
              <button
                onClick={onReset}
                style={{
                  padding: '0.25rem 0.75rem',
                  border: '1px solid rgba(255,255,255,0.5)',
                  borderRadius: 6,
                  background: 'transparent',
                  color: '#fff',
                  cursor: 'pointer',
                  fontSize: '0.8rem',
                }}
              >
                Reset to recommended
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
