import { useEffect, useMemo, useRef, useState } from 'react';

const SIZE = 600;
// Zoom is chosen per roof so the whole panel array fits; Static Maps needs an integer.
const MIN_ZOOM = 16;
const MAX_ZOOM = 22;
// Pixels kept clear around the array (also leaves room for the bottom toolbar)
const FIT_PADDING = 60;

function staticMapUrl(lat, lng, zoom) {
  const key = import.meta.env.VITE_SOLAR_KEY;
  return `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=${zoom}&size=${SIZE}x${SIZE}&maptype=satellite&key=${key}`;
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
}) {
  const [imageStatus, setImageStatus] = useState('loading'); // loading | loaded | error
  const [hoveredId, setHoveredId] = useState(null);

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

  const mapUrl = staticMapUrl(view.lat, view.lng, zoom);

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
      return {
        key: i,
        x,
        y,
        w: landscape ? portraitH : portraitW,
        h: landscape ? portraitW : portraitH,
        // Align the panel with its roof segment so rows follow the roof lines
        azimuth: roofSegments[panel.segmentIndex]?.azimuthDegrees ?? 0,
      };
    });
  }, [panels, view, zoom, panelWidthMeters, panelHeightMeters, roofSegments]);

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
          border: '1px solid #d1d5db',
          borderRadius: 12,
          overflow: 'hidden',
          background: '#e5e7eb',
          boxShadow: '0 1px 4px rgba(0,0,0,0.12)',
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
              color: '#6b7280',
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
              color: '#c62828',
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
              style={{ display: 'block', opacity: imageStatus === 'loaded' ? 1 : 0 }}
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
                    title={active ? 'Click to remove panel' : 'Click to add panel'}
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
                      backgroundColor: active
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
            <span style={{ opacity: 0.75 }}>click a panel to toggle</span>
            {isCustomized && (
              <button
                onClick={onReset}
                style={{
                  marginLeft: 'auto',
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
