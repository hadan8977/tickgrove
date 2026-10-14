import { useEffect, useRef } from "react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { basicSetup } from "codemirror";
import { pineHighlight, pineLanguage } from "../pine/language";
export default function SourceEditor({
  value,
  onChange,
  kind,
}: {
  value: string;
  onChange: (s: string) => void;
  kind: string;
}) {
  const root = useRef<HTMLDivElement>(null),
    view = useRef<EditorView | null>(null),
    callback = useRef(onChange);
  callback.current = onChange;
  useEffect(() => {
    if (!root.current) return;
    const editor = new EditorView({
      parent: root.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          ...(kind === "pine" ? [pineLanguage, pineHighlight] : []),
          EditorView.lineWrapping,
          EditorView.theme({
            "&": { height: "320px", fontSize: "13px" },
            ".cm-scroller": { overflow: "auto", fontFamily: "var(--font-mono)" },
            ".cm-content": { color: "var(--text)" },
            ".cm-gutters": {
              backgroundColor: "var(--panel-2)",
              color: "var(--faint)",
              border: "none",
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) callback.current(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
  }, [kind]);
  useEffect(() => {
    const editor = view.current;
    if (editor && editor.state.doc.toString() !== value)
      editor.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: value },
      });
  }, [value]);
  return (
    <div
      ref={root}
      className="mt-2 border border-line bg-panel-2"
      aria-label="Strategy code editor"
    />
  );
}
