import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Upload, X } from "lucide-react";
import { detectKind, detectTitle } from "../../pine/runtime";
import { uid } from "../../builder/model";
import { useScripts } from "../../store";
import { Button, IconButton, Input } from "../../ui/primitives";

export default function ImportPine({ onClose }: { onClose: () => void }) {
  const [source, setSource] = useState(""),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prior = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLTextAreaElement>("textarea")?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab") {
        const all = [
            ...(dialog.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled),input,textarea",
            ) ?? []),
          ],
          first = all[0],
          last = all.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("keydown", key);
      prior?.focus();
    };
  }, []);
  function load(text: string, filename = "") {
    if (text.length > 1_000_000 || text.includes("\0"))
      throw Error("Use a text Pine file smaller than 1 MB.");
    setSource(text);
    setName(filename.replace(/\.(pine|txt)$/i, "") || detectTitle(text));
    setError("");
  }
  function save() {
    if (!source.trim()) return;
    if (/^\s*library\s*\(/m.test(source)) {
      setError(
        "This is a reusable Pine dependency. Use More → Pine dependencies to install it, then import the indicator or strategy that uses it.",
      );
      return;
    }
    const id = uid("sc");
    useScripts.getState().upsert({
      id,
      name: name.trim() || detectTitle(source),
      source,
      kind: detectKind(source),
      updatedAt: Date.now(),
      origin: "user",
    });
    onClose();
  }
  return createPortal(
    <div
      className="fixed inset-0 z-[120] grid place-items-center bg-black/40 p-3"
      onPointerDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="pine-import-title"
        className="flex max-h-[90dvh] w-full max-w-2xl flex-col rounded-xl border border-line-2 bg-panel p-4 text-text shadow-xl"
      >
        <div className="flex items-center justify-between">
          <h2 id="pine-import-title" className="page-heading">
            Import Pine script
          </h2>
          <IconButton label="Close import" onClick={onClose}>
            <X size={17} />
          </IconButton>
        </div>
        <p className="page-description my-2">
          Paste the full script from TradingView, or open a .pine file. The source stays editable
          here.
        </p>
        <label className="my-2 flex cursor-pointer items-center gap-2 text-sm">
          <Upload size={15} /> Open .pine or .txt file
          <input
            aria-label="Pine file"
            type="file"
            accept=".pine,.txt,text/plain"
            className="min-w-0 flex-1 text-xs"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file)
                void file
                  .text()
                  .then((text) => load(text, file.name))
                  .catch((e) => setError(String(e)));
            }}
          />
        </label>
        <textarea
          aria-label="Paste Pine source"
          className="code-text my-2 h-64 min-h-32 w-full resize-y rounded-lg border border-line bg-bg p-3 text-[13px] leading-relaxed outline-none focus:border-accent"
          placeholder={'//@version=6\nindicator("My indicator", overlay=true)\nplot(close)'}
          value={source}
          onChange={(e) => setSource(e.target.value)}
        />
        <label className="text-xs text-muted">
          Script name
          <Input
            aria-label="Imported script name"
            className="mt-1"
            placeholder="Taken from the script if left blank"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {error && (
          <p role="alert" className="mt-3 text-sm text-down">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!source.trim() || source.length > 1_000_000}
            onClick={save}
          >
            Import and edit
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
