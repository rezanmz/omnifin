export function CinematicBackdrop() {
  return (
    <div className="cinematic-backdrop" aria-hidden="true">
      <span className="cinematic-backdrop__aurora cinematic-backdrop__aurora--one" />
      <span className="cinematic-backdrop__aurora cinematic-backdrop__aurora--two" />
      <span className="cinematic-backdrop__vignette" />
      <span className="cinematic-backdrop__noise" />
    </div>
  );
}
