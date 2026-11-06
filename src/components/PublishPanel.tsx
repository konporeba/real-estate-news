// The manual "Publish now" operator UI (S-08, FR-023, US-18) — the app's third hydrated island,
// mirroring ApprovalPanel's shape.
//
// It hydrates for the same reason ApprovalPanel does: publishing to real accounts is a one-way
// door, so a review step stands between the button and the request. Everything it enforces is
// re-enforced by the endpoint and again by runPublish()/record_publication(); this layer is the
// affordance, not the gate.
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { usePublish } from "@/components/hooks/usePublish";
import { PRIMARY_BUTTON } from "@/components/ui/button-styles";
import { isTestPostId } from "@/lib/publishing/test-publisher";
import { PLATFORM_LABELS } from "@/lib/selection/rules";
import { cn } from "@/lib/utils";
import type { SelectionPlatform } from "@/types";

export interface PublishPanelProps {
  digestId: string;
  platforms: SelectionPlatform[];
  /** Publishing is simulated: nothing reaches the platforms. */
  testMode: boolean;
}

export function PublishPanel({ digestId, platforms, testMode }: PublishPanelProps) {
  const publish = usePublish(digestId);
  const busy = publish.submit.status === "submitting";
  const platformNames = platforms.map((platform) => PLATFORM_LABELS[platform]).join(", ");

  return (
    <section aria-label="Publish now" className="bg-card rounded-[20px] border p-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-base font-semibold">Don’t want to wait? Publish now.</p>
          <p className="text-muted-foreground text-sm">
            {testMode
              ? `Test mode: simulates posting to ${platformNames}. Nothing is really posted.`
              : `Posts to ${platformNames}. Each platform posts on its own, so one failing doesn’t stop the others.`}
          </p>
        </div>
        <button type="button" className={PRIMARY_BUTTON} disabled={busy} onClick={publish.startReview}>
          Publish now
        </button>
      </div>

      {publish.submit.status === "error" && (
        <p
          role="alert"
          className="border-destructive bg-destructive-tint text-destructive mt-4 rounded-xl border p-3 text-sm"
        >
          {publish.submit.message}
        </p>
      )}

      {publish.submit.status === "success" && (
        <ul role="status" className="mt-4 flex flex-col gap-2">
          {publish.submit.summary.map((outcome) => (
            <li
              key={outcome.platform}
              className={cn(
                "rounded-xl border p-3 text-sm",
                outcome.ok ? "border-signal bg-signal-tint" : "border-destructive bg-destructive-tint text-destructive",
              )}
            >
              <span className="font-semibold">{PLATFORM_LABELS[outcome.platform]}</span>{" "}
              {outcome.ok
                ? isTestPostId(outcome.postId)
                  ? "test: nothing was posted"
                  : `posted — post id ${outcome.postId}`
                : `failed: ${outcome.error}`}
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={publish.reviewing}
        title="Publish this week's post now?"
        busy={busy}
        confirmLabel={busy ? "Publishing…" : "Publish now"}
        onCancel={publish.cancelReview}
        onConfirm={() => {
          void publish.confirm().then(() => {
            publish.cancelReview();
          });
        }}
      >
        <p className="text-muted-foreground text-[15px] leading-relaxed">
          {testMode
            ? `Test mode: this simulates posting to ${platformNames} and marks the week as published. Nothing is really posted.`
            : `Posts to ${platformNames}. Each platform’s result is recorded on its own — a platform that already succeeded is never posted to twice on a retry.`}
        </p>
      </ConfirmDialog>
    </section>
  );
}
