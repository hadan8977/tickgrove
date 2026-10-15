import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import PineLibraries from "../../service/PineLibraries";
import { Button } from "../../ui/primitives";
import type { DependencyRequest } from "./dependencies";

export default function DependencyDialog({ request, onClose, onInstalled }: {
  request: DependencyRequest; onClose: () => void; onInstalled: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => previous?.focus();
  }, []);
  return createPortal(
    <dialog ref={dialog} aria-label="Install Pine dependency" onCancel={(e) => { e.preventDefault(); onClose(); }}
      className="m-auto h-[min(90dvh,760px)] w-[min(96vw,960px)] rounded-xl border border-line bg-panel p-0 text-text backdrop:bg-black/40">
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line p-3">
          <span className="text-sm">Install the source for the exact imported version.</span>
          <Button onClick={onClose}>Back to script</Button>
        </div>
        <div className="min-h-0 flex-1"><PineLibraries initial={request} onSaved={onInstalled} /></div>
      </div>
    </dialog>, document.body,
  );
}
