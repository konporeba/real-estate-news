// "Edit text" on the approval page: change each story's Polish title and caption before approving.
// The fit check runs as the operator types (the renderer's own rules, copy-rules.ts), so what can be
// saved is what the slide can show. Saving sends the week back to have its slides redrawn; the
// story cards below stay as they were, for comparison, until then.
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useStoryEditor } from "@/components/hooks/useStoryEditor";
import { PRIMARY_BUTTON, SECONDARY_BUTTON } from "@/components/ui/button-styles";
import type { StoryEdit } from "@/lib/digest/copy-rules";
import { cn } from "@/lib/utils";
import type { SelectionFormat } from "@/types";

interface StoryEditorProps {
  digestId: string;
  format: SelectionFormat;
  stories: StoryEdit[];
}

const FIELD =
  "border-input bg-card w-full rounded-xl border px-4 py-3 text-base focus:outline-2 focus:outline-offset-2";

export function StoryEditor({ digestId, format, stories }: StoryEditorProps) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const editor = useStoryEditor(digestId, format, stories);
  const hasProblems = Object.keys(editor.problems).length > 0;
  const saving = editor.save.status === "saving";

  if (!editing) {
    return (
      <button
        type="button"
        className={SECONDARY_BUTTON}
        onClick={() => {
          setEditing(true);
        }}
      >
        Edit text
      </button>
    );
  }

  return (
    <div className="bg-card w-full rounded-[20px] border p-6 sm:p-7">
      <h3 className="text-lg font-bold">Edit the text</h3>
      <p className="text-muted-foreground mt-1 text-[15px]">
        {format === "carousel"
          ? "The title and caption appear on each story's slide, and the captions make up the post's text."
          : "The title appears on the slide, and the captions make up the post's text."}
      </p>

      <ol className="mt-5 flex flex-col gap-6">
        {editor.drafts.map((draft, i) => {
          const problem = editor.problems[draft.clusterId];
          return (
            <li key={draft.clusterId} className="flex flex-col gap-2.5">
              <p className="text-muted-foreground text-[13px] font-semibold tracking-[0.08em] uppercase">
                Story {i + 1} of {editor.drafts.length}
              </p>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold">Title</span>
                <input
                  type="text"
                  value={draft.polishTitle}
                  onChange={(event) => {
                    editor.update(draft.clusterId, "polishTitle", event.target.value);
                  }}
                  aria-invalid={problem ? true : undefined}
                  className={FIELD}
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-sm font-semibold">Caption</span>
                <textarea
                  rows={4}
                  value={draft.captionSummary}
                  onChange={(event) => {
                    editor.update(draft.clusterId, "captionSummary", event.target.value);
                  }}
                  aria-invalid={problem ? true : undefined}
                  className={cn(FIELD, "leading-relaxed")}
                />
              </label>
              <p
                role={problem ? "alert" : undefined}
                className={cn("text-sm", problem ? "text-destructive font-semibold" : "text-muted-foreground")}
              >
                {problem ?? "Fits the slide."}
              </p>
            </li>
          );
        })}
      </ol>

      <div className="mt-6 flex flex-wrap justify-end gap-2.5">
        <button
          type="button"
          className={SECONDARY_BUTTON}
          disabled={saving}
          onClick={() => {
            editor.reset();
            setEditing(false);
          }}
        >
          Discard changes
        </button>
        <button
          type="button"
          className={PRIMARY_BUTTON}
          disabled={!editor.changed || hasProblems || saving}
          onClick={() => {
            setConfirming(true);
          }}
        >
          Save and redraw the slides
        </button>
      </div>

      <ConfirmDialog
        open={confirming}
        title="Save your edits?"
        confirmLabel="Save and redraw"
        busy={saving}
        onConfirm={() => {
          void editor.submit();
        }}
        onCancel={() => {
          setConfirming(false);
        }}
      >
        <div className="text-muted-foreground space-y-2 text-[15px] leading-relaxed">
          <p>The slides are redrawn with your text. This starts within 5 minutes and takes a few more.</p>
          <p>You’ll get the approval email again when it’s ready, and you approve it from this page as before.</p>
        </div>
        {editor.save.status === "error" && (
          <p role="alert" className="text-destructive mt-3 text-sm font-semibold">
            {editor.save.message}
          </p>
        )}
      </ConfirmDialog>
    </div>
  );
}
