import { Skeleton } from "../ui/skeleton";

export function WorkHistorySkeleton() {
  return (
    <div role="status" aria-label="Loading work history" className="space-y-2 px-1 pb-1 pt-3">
      {[0, 1, 2].map((index) => (
        <div key={index} className="flex items-center gap-2" aria-hidden="true">
          <Skeleton className="size-3 shrink-0" />
          <Skeleton
            shape="pill"
            className={index === 0 ? "h-2.5 w-2/5" : index === 1 ? "h-2.5 w-3/5" : "h-2.5 w-1/3"}
          />
        </div>
      ))}
    </div>
  );
}
