// Twig — Twigo's mascot: a little teal sprout. Pixel art rendered as <rect>s so
// it stays crisp at any size; colours come from theme tokens, so it re-skins
// with --brand like everything else.
const ART = [
  ".....L.L.....",
  "....LLSLL....",
  "......S......",
  "....BBBBB....",
  "...BBBBBBB...",
  "..BBBBBBBBB..",
  "..BBBBBBBBB..",
  "..BBIBBBIBB..",
  "..BBBBBBBBB..",
  "..BBIBBBIBB..",
  "...BBIIIBB...",
  "....BB.BB....",
];

const FILL: Record<string, string> = {
  B: "var(--brand)",
  L: "var(--ok)",
  S: "var(--ok)",
  // Face ink: a fixed deep teal so eyes/smile read on the body in both themes.
  I: "oklch(0.24 0.04 220)",
};

const COLS = ART[0]?.length ?? 0;
const ROWS = ART.length;

export function TwigMascot({ className }: { className?: string }) {
  return (
    <svg
      viewBox={`0 0 ${COLS} ${ROWS}`}
      shapeRendering="crispEdges"
      className={className}
      role="img"
      aria-label="Twig, the Twigo mascot"
    >
      {ART.flatMap((row, y) =>
        Array.from(row).map((ch, x) => {
          const fill = FILL[ch];
          return fill ? (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={1.02}
              height={1.02}
              fill={fill}
            />
          ) : null;
        }),
      )}
    </svg>
  );
}
