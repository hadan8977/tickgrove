import { useApp } from "../store";
import { openPanel } from "../features/workspace/dock";

/** Every start action lands on its actual strategy ledger, including from Scripts. */
export function showPaperSession(sessionId: string) {
  useApp.setState({ view: "workspace", paperSessionId: sessionId });
  openPanel("positions", {}, { direction: "below" });
}
