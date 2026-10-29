/**
 * Local Provider
 *
 * Implements the ConwayClient interface without Conway. Commands run on the
 * host (or inside a Docker container), files live on the local disk, and
 * "credits" come from the local ledger. Everything Conway-specific (sandbox
 * lifecycle, domains, credit transfers, registration) fails fast with a
 * clear error so the agent learns the capability does not exist here.
 *
 * WHY an adapter instead of removing ConwayClient: twenty files depend on
 * the interface. Satisfying it keeps the agent loop, tools, git versioning
 * and heartbeat untouched while swapping the infrastructure underneath.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type {
  ConwayClient,
  ExecResult,
  PortInfo,
  CreateSandboxOptions,
  SandboxInfo,
  PricingTier,
  CreditTransferResult,
  DomainSearchResult,
  DomainRegistration,
  DnsRecord,
  ModelInfo,
} from "../types.js";
import type { Ledger } from "./ledger.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("local-provider");
const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export type ExecTarget = { kind: "host" } | { kind: "docker"; container: string };

export interface LocalProviderOptions {
  ledger: Ledger;
  /** Directory the agent treats as its home for commands and relative paths. */
  workspaceDir: string;
  execTarget: ExecTarget;
}

class NotAvailableError extends Error {
  constructor(capability: string) {
    super(`${capability} is not available in local mode. Ask the creator if you need it.`);
    this.name = "NotAvailableError";
  }
}

export function createLocalProvider(options: LocalProviderOptions): ConwayClient {
  const { ledger, workspaceDir, execTarget } = options;
  fs.mkdirSync(workspaceDir, { recursive: true });

  const resolveLocal = (filePath: string): string => {
    if (filePath.startsWith("~")) {
      return path.join(process.env.HOME || workspaceDir, filePath.slice(1));
    }
    return path.isAbsolute(filePath) ? filePath : path.join(workspaceDir, filePath);
  };

  const exec = (command: string, timeout?: number): Promise<ExecResult> =>
    new Promise((resolve) => {
      const timeoutMs = timeout || DEFAULT_EXEC_TIMEOUT_MS;
      // WHY execFile with an argv array: the agent's command is passed to one
      // shell as a single argument, never re-interpolated by a second shell.
      const [file, args] =
        execTarget.kind === "docker"
          ? ["docker", ["exec", "-w", "/workspace", execTarget.container, "sh", "-c", command]]
          : ["/bin/sh", ["-c", command]];
      execFile(
        file,
        args,
        { cwd: workspaceDir, timeout: timeoutMs, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf-8" },
        (err: any, stdout, stderr) => {
          if (err && typeof err.code !== "number") {
            // Spawn failure or timeout: surface it as a failed command.
            const detail = err.killed ? `timed out after ${timeoutMs}ms` : err.message;
            resolve({ stdout: stdout || "", stderr: `${stderr || ""}${detail}`.trim(), exitCode: 124 });
            return;
          }
          resolve({ stdout: stdout || "", stderr: stderr || "", exitCode: err ? err.code : 0 });
        },
      );
    });

  const writeFile = async (filePath: string, content: string): Promise<void> => {
    if (execTarget.kind === "docker") {
      const result = await exec(`mkdir -p "$(dirname '${escapeSingle(filePath)}')" && cat > '${escapeSingle(filePath)}' <<'AUTOMATON_EOF'\n${content}\nAUTOMATON_EOF`);
      if (result.exitCode !== 0) throw new Error(`writeFile failed: ${result.stderr}`);
      return;
    }
    const target = resolveLocal(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf-8");
  };

  const readFile = async (filePath: string): Promise<string> => {
    if (execTarget.kind === "docker") {
      const result = await exec(`cat '${escapeSingle(filePath)}'`);
      if (result.exitCode !== 0) throw new Error(`readFile failed: ${result.stderr}`);
      return result.stdout;
    }
    return fs.readFileSync(resolveLocal(filePath), "utf-8");
  };

  const notAvailable = (capability: string) => async (): Promise<never> => {
    throw new NotAvailableError(capability);
  };

  const client: ConwayClient = {
    exec,
    writeFile,
    readFile,
    exposePort: notAvailable("Port exposure") as () => Promise<PortInfo>,
    removePort: notAvailable("Port exposure") as () => Promise<void>,
    createSandbox: notAvailable("Sandbox creation") as (o: CreateSandboxOptions) => Promise<SandboxInfo>,
    deleteSandbox: notAvailable("Sandbox deletion") as () => Promise<void>,
    listSandboxes: async (): Promise<SandboxInfo[]> => [],
    getCreditsBalance: async (): Promise<number> => ledger.balanceCents(),
    getCreditsPricing: async (): Promise<PricingTier[]> => [],
    transferCredits: notAvailable("Credit transfer") as () => Promise<CreditTransferResult>,
    registerAutomaton: notAvailable("Conway registration") as ConwayClient["registerAutomaton"],
    searchDomains: notAvailable("Domain search") as () => Promise<DomainSearchResult[]>,
    registerDomain: notAvailable("Domain registration") as () => Promise<DomainRegistration>,
    listDnsRecords: notAvailable("DNS management") as () => Promise<DnsRecord[]>,
    addDnsRecord: notAvailable("DNS management") as () => Promise<DnsRecord>,
    deleteDnsRecord: notAvailable("DNS management") as () => Promise<void>,
    listModels: async (): Promise<ModelInfo[]> => [],
    createScopedClient: () => client,
  };

  logger.info(
    `Local provider ready (${execTarget.kind}${execTarget.kind === "docker" ? `: ${execTarget.container}` : ""}, workspace ${workspaceDir})`,
  );
  return client;
}

function escapeSingle(value: string): string {
  return value.replace(/'/g, "'\\''");
}
