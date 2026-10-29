/**
 * Approval Notifications
 *
 * Tells the creator that the automaton is waiting on a decision.
 * macOS: native notification via osascript. Everywhere: structured log line.
 *
 * WHY: the creator is not watching the terminal. Without a push signal a
 * pending approval silently blocks the agent until it expires.
 */

import { execFile } from "node:child_process";
import { createLogger } from "../observability/logger.js";
import type { ApprovalRow } from "./store.js";

const logger = createLogger("approval-notify");

export function notifyApprovalRequest(row: ApprovalRow, dashboardUrl: string): void {
  const summary = `${row.toolName} [${row.riskLevel}]`;
  logger.info(`APPROVAL NEEDED: ${summary} -> ${dashboardUrl}`);

  if (process.platform !== "darwin") return;

  // execFile with an argument array: tool names and args never touch a shell.
  const script =
    `display notification "${escapeAppleScript(summary)}" ` +
    `with title "Automaton needs approval" subtitle "${escapeAppleScript(dashboardUrl)}" sound name "Ping"`;
  execFile("osascript", ["-e", script], (err) => {
    if (err) logger.debug(`osascript notification failed: ${err.message}`);
  });
}

function escapeAppleScript(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
