// The manual "Publish now" operator UI (S-08, FR-023, US-18) — the app's third hydrated island,
// mirroring ApprovalPanel's shape.
//
// It hydrates for the same reason ApprovalPanel does: publishing to real accounts is a one-way
// door, so a review step stands between the button and the request. Everything it enforces is
// re-enforced by the endpoint and again by runPublish()/record_publication(); this layer is the
// affordance, not the gate.
import { usePublish } from "@/components/hooks/usePublish";
import { PLATFORM_LABELS } from "@/lib/selection/rules";
import { cn } from "@/lib/utils";
import type { SelectionPlatform } from "@/types";

export interface PublishPanelProps {
  digestId: string;
  platforms: SelectionPlatform[];
}

const PUBLISH_BUTTON =
  "rounded-lg bg-blue-500 px-4 py-2 font-semibold text-white transition-colors hover:bg-blue-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-blue-500";
const SECONDARY_BUTTON =
  "rounded-lg border border-white/20 bg-white/5 px-4 py-2 font-semibold text-blue-100/80 transition-colors hover:bg-white/10";

export function PublishPanel({ digestId, platforms }: PublishPanelProps) {
  const publish = usePublish(digestId);
  const busy = publish.submit.status === "submitting";
  const platformNames = platforms.map((platform) => PLATFORM_LABELS[platform]).join(", ");

  return (
    <div className="mb-6 rounded-xl border border-white/10 bg-slate-900/80 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold">Publish this week’s post</p>
          <p className="text-xs text-blue-100/60">
            Posts to {platformNames}. Each platform posts independently — one failing does not stop the others.
          </p>
        </div>
        <button type="button" className={PUBLISH_BUTTON} disabled={busy} onClick={publish.startReview}>
          Publish now
        </button>
      </div>

      {publish.submit.status === "error" && (
        <div className="mt-4 rounded-lg border border-red-400/30 bg-red-500/10 p-3 text-sm text-red-200">
          <p>{publish.submit.message}</p>
        </div>
      )}

      {publish.submit.status === "success" && (
        <ul className="mt-4 space-y-2">
          {publish.submit.summary.map((outcome) => (
            <li
              key={outcome.platform}
              className={cn(
                "rounded-lg border p-3 text-sm",
                outcome.ok
                  ? "border-green-400/30 bg-green-500/10 text-green-200"
                  : "border-red-400/30 bg-red-500/10 text-red-200",
              )}
            >
              <span className="font-semibold">{PLATFORM_LABELS[outcome.platform]}</span>{" "}
              {outcome.ok ? `succeeded — post id ${outcome.postId}` : `failed: ${outcome.error}`}
            </li>
          ))}
        </ul>
      )}

      {publish.reviewing && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm publish"
          className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4"
        >
          <div className="max-h-full w-full max-w-lg overflow-y-auto rounded-xl border border-white/15 bg-slate-900 p-6 text-white shadow-xl">
            <h2 className="text-lg font-semibold">Publish this week’s post</h2>
            <p className="mt-1 text-sm text-blue-100/70">
              Posts to {platformNames}. Each platform’s result is recorded independently — a platform that already
              succeeded is never re-posted to on a retry.
            </p>

            <div className="mt-6 flex justify-end gap-3">
              <button type="button" className={SECONDARY_BUTTON} disabled={busy} onClick={publish.cancelReview}>
                Back
              </button>
              <button
                type="button"
                className={PUBLISH_BUTTON}
                disabled={busy}
                onClick={() => {
                  // On both success and failure the dialog must close, so the result banner or
                  // per-platform list it produced isn't sitting hidden behind this overlay --
                  // mirrors ApprovalPanel's identical post-confirm cleanup.
                  void publish.confirm().then(() => {
                    publish.cancelReview();
                  });
                }}
              >
                {busy ? "Publishing…" : "Confirm publish"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
