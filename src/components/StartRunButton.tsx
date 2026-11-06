// "Start a new run" on the dashboard, shown in test mode only: lets a tester begin from collection
// at any time instead of waiting for Sunday.
import { useState } from "react";

import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useStartRun } from "@/components/hooks/useStartRun";
import { SECONDARY_BUTTON } from "@/components/ui/button-styles";

export function StartRunButton() {
  const [confirming, setConfirming] = useState(false);
  const run = useStartRun();

  return (
    <>
      <button
        type="button"
        className={SECONDARY_BUTTON}
        onClick={() => {
          run.reset();
          setConfirming(true);
        }}
      >
        Start a new run
      </button>
      <ConfirmDialog
        open={confirming}
        title="Start a new run?"
        confirmLabel="Start the run"
        busy={run.state.status === "starting"}
        onConfirm={() => {
          void run.start();
        }}
        onCancel={() => {
          setConfirming(false);
        }}
      >
        <p className="text-muted-foreground text-[15px] leading-relaxed">
          This collects and ranks this week’s news. It usually takes about 10 minutes, and you’ll get an email when the
          shortlist is ready.
        </p>
        {run.state.status === "error" && (
          <p role="alert" className="text-destructive mt-3 text-sm font-semibold">
            {run.state.message}
          </p>
        )}
      </ConfirmDialog>
    </>
  );
}
