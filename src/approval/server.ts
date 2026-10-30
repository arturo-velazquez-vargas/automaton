/**
 * Approval Dashboard Server
 *
 * Loopback-only HTTP server where the creator reviews and resolves pending
 * tool calls. No framework: node:http is enough for four routes.
 *
 * WHY loopback + custom header: the server binds to 127.0.0.1 so nothing
 * outside the laptop reaches it, and every mutating request must carry
 * `X-Automaton-Approval`. A browser tab on another site cannot add that
 * header without a CORS preflight, which this server never answers, so a
 * malicious page cannot approve actions on the creator's behalf.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Database as DatabaseType } from "better-sqlite3";
import { createLogger } from "../observability/logger.js";
import { DASHBOARD_HTML } from "./dashboard-page.js";
import { listPendingApprovals, listRecentApprovals, resolveApproval } from "./store.js";

const logger = createLogger("approval-server");
const APPROVAL_HEADER = "x-automaton-approval";
const MAX_BODY_BYTES = 16 * 1024;

export interface ApprovalServerOptions {
  db: DatabaseType;
  port: number;
  host?: string;
  getAgentState?: () => string;
  /** Local-mode ledger balance, shown in the dashboard header. */
  getBalanceCents?: () => number;
  /** Deliver a creator message to the agent's inbox and wake it. */
  onCreatorMessage?: (content: string) => void;
}

export interface ApprovalServer {
  url: string;
  close(): Promise<void>;
}

export async function startApprovalServer(options: ApprovalServerOptions): Promise<ApprovalServer> {
  const host = options.host ?? "127.0.0.1";
  const { db } = options;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}`);

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(DASHBOARD_HTML);
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, {
          agentState: options.getAgentState?.() ?? "unknown",
          balanceCents: options.getBalanceCents?.() ?? null,
          pending: listPendingApprovals(db),
          recent: listRecentApprovals(db, 30),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/message") {
        if (req.headers[APPROVAL_HEADER] !== "1") {
          sendJson(res, 403, { error: "missing approval header" });
          return;
        }
        if (!options.onCreatorMessage) {
          sendJson(res, 404, { error: "messaging not enabled" });
          return;
        }
        const body = await readJsonBody(req);
        const content = typeof body.content === "string" ? body.content.trim().slice(0, 4000) : "";
        if (!content) {
          sendJson(res, 400, { error: "content required" });
          return;
        }
        options.onCreatorMessage(content);
        logger.info(`Creator message queued (${content.length} chars)`);
        sendJson(res, 200, { ok: true });
        return;
      }

      const match = url.pathname.match(/^\/api\/approvals\/([A-Za-z0-9]+)\/(approve|deny)$/);
      if (req.method === "POST" && match) {
        if (req.headers[APPROVAL_HEADER] !== "1") {
          sendJson(res, 403, { error: "missing approval header" });
          return;
        }
        const body = await readJsonBody(req);
        const note = typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : undefined;
        const status = match[2] === "approve" ? "approved" : "denied";
        const changed = resolveApproval(db, match[1], status, note);
        if (!changed) {
          sendJson(res, 409, { error: "approval already resolved or unknown" });
          return;
        }
        logger.info(`Creator ${status} ${match[1]}${note ? ` (${note})` : ""}`);
        sendJson(res, 200, { id: match[1], status });
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err: any) {
      logger.error(`Approval server error: ${err.message}`);
      sendJson(res, 500, { error: "internal error" });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, host, () => resolve());
  });

  const address = server.address() as AddressInfo;
  const url = `http://${host}:${address.port}`;
  logger.info(`Approval dashboard listening at ${url}`);

  return {
    url,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
        resolve(parsed && typeof parsed === "object" ? parsed : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}
