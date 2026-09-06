export default function Loading() {
  return (
    <div className="space-y-6 animate-fade-in">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="skeleton-shimmer h-[76px] rounded-lg bg-muted"
          />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-3">
        <div className="skeleton-shimmer h-72 rounded-lg bg-muted lg:col-span-2" />
        <div className="skeleton-shimmer h-72 rounded-lg bg-muted" />
      </div>
      <div className="skeleton-shimmer h-48 rounded-lg bg-muted" />
    </div>
  );
}
