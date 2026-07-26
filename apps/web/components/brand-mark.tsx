export function BrandMark({ compact = false }: { compact?: boolean }) {
  return (
    <span className="brand" aria-label="Omnifin" role="img">
      <span className="brand__glyph" aria-hidden="true">
        <span className="brand__core" />
      </span>
      {!compact && <span className="brand__word">Omnifin</span>}
    </span>
  );
}
