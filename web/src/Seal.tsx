import { PIXELS } from "./fx/mne";

// The badge: a scalloped seal with a ribbon across it and Mne on top, after the
// starbursts on 1950s packaging. Pure SVG, coloured by classes, so it follows the theme.
const N = 22;
const scallop = (() => {
  const pts: string[] = [];
  for (let i = 0; i <= N * 8; i++) {
    const a = (i / (N * 8)) * Math.PI * 2;
    const r = 48 + 2.6 * Math.cos(a * N);
    pts.push(`${(50 + Math.cos(a) * r).toFixed(2)},${(50 + Math.sin(a) * r).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
})();

const CLASS = ["px-eye", "px-line", "px-ear", "px-hide", "px-blush", "px-tusk"];

export function Seal({ className, label = "Mnemo", sub = "★ never forgets ★" }: { className?: string; label?: string; sub?: string }) {
  return (
    <svg className={className ? `seal ${className}` : "seal"} viewBox="-6 -6 112 112" aria-hidden="true" focusable="false">
      <g className="seal-spin">
        <path className="seal-edge" d={scallop} />
        <circle className="seal-ring" cx="50" cy="50" r="40" />
      </g>
      <g transform="translate(32 9) scale(2)" shapeRendering="crispEdges">
        {PIXELS.map((p) => (
          <rect key={`${p.x}-${p.y}`} className={CLASS[p.c]} x={p.x} y={p.y} width="1.02" height="1.02" />
        ))}
      </g>
      <path className="seal-ribbon-tail" d="M-4 62 L10 62 L10 80 L-4 80 L2 71 Z M104 62 L90 62 L90 80 L104 80 L98 71 Z" />
      <rect className="seal-ribbon" x="4" y="58" width="92" height="20" />
      <text className="seal-text" x="50" y="72.5" textAnchor="middle">{label}</text>
      <text className="seal-sub" x="50" y="89" textAnchor="middle">{sub}</text>
    </svg>
  );
}
