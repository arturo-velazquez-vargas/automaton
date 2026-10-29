#!/usr/bin/env node
/**
 * Conway Automaton Runtime
 *
 * The entry point for the sovereign AI agent.
 * Handles CLI args, bootstrapping, and orchestrating
 * the heartbeat daemon + agent loop.
 */

import fs from "fs";
import path from "path";
import { getWallet, getAutomatonDir } from "./identity/wallet.js";
import { provision, loadApiKeyFromConfig } from "./identity/provision.js";
import { loadConfig, resolvePath } from "./config.js";
import { createDatabase } from "./state/database.js";
import { createConwayClient } from "./conway/client.js";
import { createInferenceClient } from "./conway/inference.js";
import { createHeartbeatDaemon } from "./heartbeat/daemon.js";
import {
  loadHeartbeatConfig,
  syncHeartbeatToDb,
} from "./heartbeat/config.js";
import { consumeNextWakeEvent, insertWakeEvent } from "./state/database.js";
import { runAgentLoop } from "./agent/loop.js";
import { ModelRegistry } from "./inference/registry.js";
import { loadSkills } from "./skills/loader.js";
import { initStateRepo } from "./git/state-versioning.js";
import { createSocialClient } from "./social/client.js";
import { PolicyEngine } from "./agent/policy-engine.js";
import { SpendTracker } from "./agent/spend-tracker.js";
import { createDefaultRules } from "./agent/policy-rules/index.js";
import type { AutomatonIdentity, AgentState, Skill, SocialClientInterface, AutomatonConfig, AutomatonDatabase, ConwayClient, HeartbeatConfig } from "./types.js";
import type { PrivateKeyAccount } from "viem";
import type { ChainIdentity, ChainType } from "./identity/chain.js";
import { Ledger } from "./local/ledger.js";
import { createLocalProvider } from "./local/provider.js";
import { createLocalIdentity } from "./local/identity.js";
import { DEFAULT_TREASURY_POLICY, DEFAULT_APPROVAL_CONFIG, DEFAULT_LOCAL_CONFIG } from "./types.js";
import { ApprovalGate } from "./approval/gate.js";
import { startApprovalServer, type ApprovalServer } from "./approval/server.js";
import { notifyApprovalRequest } from "./approval/notify.js";
import { createLogger, setGlobalLogLevel, StructuredLogger } from "./observability/logger.js";
import { prettySink } from "./observability/pretty-sink.js";
import { bootstrapTopup } from "./conway/topup.js";
import { randomUUID } from "crypto";
import { keccak256, toHex } from "viem";

const logger = createLogger("main");
const VERSION = "0.2.1";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // ─── CLI Commands ────────────────────────────────────────────

  if (args.includes("--version") || args.includes("-v")) {
    logger.info(`Conway Automaton v${VERSION}`);
    process.exit(0);
  }

  if (args.includes("--help") || args.includes("-h")) {
    logger.info(`
Conway Automaton v${VERSION}
Sovereign AI Agent Runtime

Usage:
  automaton --run          Start the automaton (first run triggers setup wizard)
  automaton --setup        Re-run the interactive setup wizard
  automaton --configure    Edit configuration (providers, model, treasury, general)
  automaton --pick-model   Interactively pick the active inference model
  automaton --init         Initialize wallet and config directory
  automaton --provision    Provision Conway API key via SIWE
  automaton --status       Show current automaton status
  automaton --fund <usd>   Add USD to the local ledger (local mode)
  automaton --version      Show version
  automaton --help         Show this help

Environment:
  CONWAY_API_URL           Conway API URL (default: https://api.conway.tech)
  CONWAY_API_KEY           Conway API key (overrides config)
  OLLAMA_BASE_URL          Ollama base URL (overrides config, e.g. http://localhost:11434)
`);
    process.exit(0);
  }

  if (args.includes("--init")) {
    // Read chain type from genesis.json if written by parent during spawn
    let initChainType: import("./identity/chain.js").ChainType | undefined;
    try {
      const genesisPath = path.join(getAutomatonDir(), "genesis.json");
      if (fs.existsSync(genesisPath)) {
        const genesis = JSON.parse(fs.readFileSync(genesisPath, "utf-8"));
        initChainType = genesis.chainType;
      }
    } catch {}
    const { chainIdentity, isNew } = await getWallet(initChainType);
    logger.info(
      JSON.stringify({
        address: chainIdentity.address,
        isNew,
        configDir: getAutomatonDir(),
      }),
    );
    process.exit(0);
  }

  if (args.includes("--provision")) {
    try {
      const result = await provision();
      logger.info(JSON.stringify(result));
    } catch (err: any) {
      logger.error(`Provision failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes("--fund")) {
    const raw = args[args.indexOf("--fund") + 1];
    const usd = Number(raw);
    if (!raw || !Number.isFinite(usd) || usd <= 0) {
      logger.error("Usage: automaton --fund <usd>   e.g. automaton --fund 25");
      process.exit(1);
    }
    const config = loadConfig();
    if (!config) {
      logger.error("Automaton is not configured. Run: automaton --run");
      process.exit(1);
    }
    if (config.runtimeMode === "conway") {
      logger.error("--fund only applies to local mode. Use the creator CLI for Conway credits.");
      process.exit(1);
    }
    const db = createDatabase(resolvePath(config.dbPath));
    const ledger = new Ledger(db.raw);
    ledger.credit(Math.round(usd * 100), "creator funding", "cli");
    logger.info(`Funded $${usd.toFixed(2)}. Balance: $${(ledger.balanceCents() / 100).toFixed(2)}`);
    db.close();
    process.exit(0);
  }

  if (args.includes("--status")) {
    await showStatus();
    process.exit(0);
  }

  if (args.includes("--setup")) {
    const { runSetupWizard } = await import("./setup/wizard.js");
    await runSetupWizard();
    process.exit(0);
  }

  if (args.includes("--pick-model")) {
    const { runModelPicker } = await import("./setup/model-picker.js");
    await runModelPicker();
    process.exit(0);
  }

  if (args.includes("--configure")) {
    const { runConfigure } = await import("./setup/configure.js");
    await runConfigure();
    process.exit(0);
  }

  if (args.includes("--run")) {
    StructuredLogger.setSink(prettySink);
    await run();
    return;
  }

  // Default: show help
  logger.info('Run "automaton --help" for usage information.');
  logger.info('Run "automaton --run" to start the automaton.');
}

// ─── Status Command ────────────────────────────────────────────

async function showStatus(): Promise<void> {
  const config = loadConfig();
  if (!config) {
    logger.info("Automaton is not configured. Run the setup script first.");
    return;
  }

  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  const state = db.getAgentState();
  const turnCount = db.getTurnCount();
  const tools = db.getInstalledTools();
  const heartbeats = db.getHeartbeatEntries();
  const skills = db.getSkills(true);
  const children = db.getChildren();
  const registry = db.getRegistryEntry();

  logger.info(`
=== AUTOMATON STATUS ===
Name:       ${config.name}
Address:    ${config.walletAddress}
Creator:    ${config.creatorAddress}
Sandbox:    ${config.sandboxId}
State:      ${state}
Turns:      ${turnCount}
Tools:      ${tools.length} installed
Skills:     ${skills.length} active
Heartbeats: ${heartbeats.filter((h) => h.enabled).length} active
Children:   ${children.filter((c) => c.status !== "dead").length} alive / ${children.length} total
Agent ID:   ${registry?.agentId || "not registered"}
Model:      ${config.inferenceModel}
Approval:   ${config.approval?.mode ?? "risky"} (dashboard :${config.approval?.dashboardPort ?? 7777})
Mode:       ${config.runtimeMode ?? "local"}${config.runtimeMode !== "conway" ? ` (balance $${(new Ledger(db.raw).balanceCents() / 100).toFixed(2)})` : ""}
Version:    ${config.version}
========================
`);

  db.close();
}

// ─── Main Run ──────────────────────────────────────────────────

async function run(): Promise<void> {
  logger.info(`[${new Date().toISOString()}] Conway Automaton v${VERSION} starting...`);

  // Load config — first run triggers interactive setup wizard
  let config = loadConfig();
  if (!config) {
    if (process.env.AUTOMATON_RUNTIME_MODE === "conway") {
      const { runSetupWizard } = await import("./setup/wizard.js");
      config = await runSetupWizard();
    } else {
      const { runLocalSetupWizard } = await import("./setup/local-wizard.js");
      config = await runLocalSetupWizard();
    }
  }

  const isLocalMode = config.runtimeMode !== "conway";

  // Initialize database
  const dbPath = resolvePath(config.dbPath);
  const db = createDatabase(dbPath);

  // Identity + infrastructure provider. Local mode: no wallet, no Conway.
  const boot = isLocalMode ? bootstrapLocal(config, db) : await bootstrapConway(config, db);
  const { identity, conway, ledger } = boot;
  const apiKey = identity.apiKey;
  logger.info(`[${new Date().toISOString()}] Runtime mode: ${isLocalMode ? "local" : "conway"}`);

  // Resolve Ollama base URL: env var takes precedence over config
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || config.ollamaBaseUrl;

  // Create inference client — pass a live registry lookup so model names like
  // "gpt-oss:120b" route to Ollama based on their registered provider, not heuristics.
  const modelRegistry = new ModelRegistry(db.raw);
  modelRegistry.initialize();
  const inference = createInferenceClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    defaultModel: config.inferenceModel,
    maxTokens: config.maxTokensPerTurn,
    lowComputeModel: config.modelStrategy?.lowComputeModel || "claude-haiku-5-5",
    openaiApiKey: config.openaiApiKey,
    anthropicApiKey: config.anthropicApiKey,
    ollamaBaseUrl,
    getModelProvider: (modelId) => modelRegistry.get(modelId)?.provider,
  });

  if (ollamaBaseUrl) {
    logger.info(`[${new Date().toISOString()}] Ollama backend: ${ollamaBaseUrl}`);
  }

  // Social relay needs a signing wallet: Conway mode only.
  let social: SocialClientInterface | undefined;
  if (!isLocalMode && config.socialRelayUrl && boot.kind === "conway") {
    social = createSocialClient(
      config.socialRelayUrl,
      boot.chainType === "solana" ? boot.chainIdentity : boot.account,
    );
    logger.info(`[${new Date().toISOString()}] Social relay: ${config.socialRelayUrl}`);
  }

  // Initialize PolicyEngine + SpendTracker (Phase 1.4)
  const treasuryPolicy = config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY;
  const rules = createDefaultRules(treasuryPolicy);
  const policyEngine = new PolicyEngine(db.raw, rules);
  const spendTracker = new SpendTracker(db.raw);

  // Load and sync heartbeat config
  const heartbeatConfigPath = resolvePath(config.heartbeatConfigPath);
  const heartbeatConfig = loadHeartbeatConfig(heartbeatConfigPath);
  if (isLocalMode) {
    disableConwayHeartbeatEntries(heartbeatConfig);
  }
  syncHeartbeatToDb(heartbeatConfig, db);

  // Load skills
  const skillsDir = config.skillsDir || "~/.automaton/skills";
  let skills: Skill[] = [];
  try {
    skills = loadSkills(skillsDir, db);
    logger.info(`[${new Date().toISOString()}] Loaded ${skills.length} skills.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Skills loading failed: ${err.message}`);
  }

  // Initialize state repo (git)
  try {
    await initStateRepo(conway);
    logger.info(`[${new Date().toISOString()}] State repo initialized.`);
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] State repo init failed: ${err.message}`);
  }

  // Bootstrap topup (Conway mode): buy minimum credits ($5) from USDC so the
  // agent can start. The agent decides larger topups itself via topup_credits.
  if (boot.kind === "conway") {
    try {
      let bootstrapTimer: ReturnType<typeof setTimeout>;
      const bootstrapTimeout = new Promise<null>((_, reject) => {
        bootstrapTimer = setTimeout(() => reject(new Error("bootstrap topup timed out")), 15_000);
      });
      try {
        await Promise.race([
          (async () => {
            const creditsCents = await conway.getCreditsBalance().catch(() => 0);
            const topupResult = await bootstrapTopup({
              apiUrl: config.conwayApiUrl,
              account: boot.account,
              creditsCents,
              chainType: boot.chainType,
            });
            if (topupResult?.success) {
              logger.info(
                `[${new Date().toISOString()}] Bootstrap topup: +$${topupResult.amountUsd} credits from USDC`,
              );
            }
          })(),
          bootstrapTimeout,
        ]);
      } finally {
        clearTimeout(bootstrapTimer!);
      }
    } catch (err: any) {
      logger.warn(`[${new Date().toISOString()}] Bootstrap topup skipped: ${err.message}`);
    }
  } else {
    logger.info(
      `[${new Date().toISOString()}] Ledger balance: $${(ledger!.balanceCents() / 100).toFixed(2)}. Fund with: automaton --fund <usd>`,
    );
  }

  // Start heartbeat daemon (Phase 1.1: DurableScheduler)
  const heartbeat = createHeartbeatDaemon({
    identity,
    config,
    heartbeatConfig,
    db,
    rawDb: db.raw,
    conway,
    social,
    onWakeRequest: (reason) => {
      logger.info(`[HEARTBEAT] Wake request: ${reason}`);
      // Phase 1.1: Use wake_events table instead of KV wake_request
      insertWakeEvent(db.raw, 'heartbeat', reason);
    },
  });

  heartbeat.start();
  logger.info(`[${new Date().toISOString()}] Heartbeat daemon started.`);

  // Creator approval gate + dashboard (fork addition)
  const approvalConfig = config.approval ?? DEFAULT_APPROVAL_CONFIG;
  let approvalGate: ApprovalGate | undefined;
  let approvalServer: ApprovalServer | undefined;
  if (approvalConfig.mode !== "off") {
    approvalServer = await startApprovalServer({
      db: db.raw,
      port: approvalConfig.dashboardPort,
      getAgentState: () => db.getAgentState(),
      getBalanceCents: ledger ? () => ledger.balanceCents() : undefined,
    });
    const dashboardUrl = approvalServer.url;
    approvalGate = new ApprovalGate(db.raw, {
      config: approvalConfig,
      onRequest: (row) => notifyApprovalRequest(row, dashboardUrl),
    });
    logger.info(
      `[${new Date().toISOString()}] Approval gate active (mode: ${approvalConfig.mode}). Dashboard: ${dashboardUrl}`,
    );
  } else {
    logger.warn(`[${new Date().toISOString()}] Approval gate OFF: tools run without creator review.`);
  }

  // Handle graceful shutdown
  const shutdown = () => {
    logger.info(`[${new Date().toISOString()}] Shutting down...`);
    heartbeat.stop();
    void approvalServer?.close();
    db.setAgentState("sleeping");
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // ─── Main Run Loop ──────────────────────────────────────────
  // The automaton alternates between running and sleeping.
  // The heartbeat can wake it up.

  while (true) {
    try {
      // Reload skills (may have changed since last loop)
      try {
        skills = loadSkills(skillsDir, db);
      } catch (error) {
        logger.error("Skills reload failed", error instanceof Error ? error : undefined);
      }

      // Run the agent loop
      await runAgentLoop({
        identity,
        config,
        db,
        conway,
        inference,
        social,
        skills,
        policyEngine,
        spendTracker,
        ollamaBaseUrl,
        approvalGate,
        onStateChange: (state: AgentState) => {
          logger.info(`[${new Date().toISOString()}] State: ${state}`);
        },
        onTurnComplete: (turn) => {
          if (ledger && turn.costCents > 0) {
            ledger.debit(turn.costCents, "inference", turn.id);
          }
          logger.info(
            `[${new Date().toISOString()}] Turn ${turn.id}: ${turn.toolCalls.length} tools, ${turn.tokenUsage.totalTokens} tokens`,
          );
        },
      });

      // Agent loop exited (sleeping or dead)
      const state = db.getAgentState();

      if (state === "dead") {
        logger.info(`[${new Date().toISOString()}] Automaton is dead. Heartbeat will continue.`);
        // In dead state, we just wait for funding
        // The heartbeat will keep checking and broadcasting distress
        await sleep(300_000); // Check every 5 minutes
        continue;
      }

      if (state === "sleeping") {
        const sleepUntilStr = db.getKV("sleep_until");
        const sleepUntil = sleepUntilStr
          ? new Date(sleepUntilStr).getTime()
          : Date.now() + 60_000;
        const sleepMs = Math.max(sleepUntil - Date.now(), 10_000);
        logger.info(
          `[${new Date().toISOString()}] Sleeping for ${Math.round(sleepMs / 1000)}s`,
        );

        // Sleep, but check for wake requests periodically
        const checkInterval = Math.min(sleepMs, 30_000);
        let slept = 0;
        while (slept < sleepMs) {
          await sleep(checkInterval);
          slept += checkInterval;

          // Phase 1.1: Check for wake events from wake_events table (atomic consume)
          const wakeEvent = consumeNextWakeEvent(db.raw);
          if (wakeEvent) {
            logger.info(
              `[${new Date().toISOString()}] Woken by ${wakeEvent.source}: ${wakeEvent.reason}`,
            );
            db.deleteKV("sleep_until");
            break;
          }
        }

        // Clear sleep state
        db.deleteKV("sleep_until");
        continue;
      }
    } catch (err: any) {
      logger.error(
        `[${new Date().toISOString()}] Fatal error in run loop: ${err.message}`,
      );
      // Wait before retrying
      await sleep(30_000);
    }
  }
}

// ─── Bootstrap: Conway mode (upstream behavior) ───────────────

type ConwayBoot = {
  kind: "conway";
  identity: AutomatonIdentity;
  conway: ConwayClient;
  ledger: undefined;
  account: PrivateKeyAccount;
  chainIdentity: ChainIdentity;
  chainType: ChainType;
};

type LocalBoot = {
  kind: "local";
  identity: AutomatonIdentity;
  conway: ConwayClient;
  ledger: Ledger;
};

async function bootstrapConway(config: AutomatonConfig, db: AutomatonDatabase): Promise<ConwayBoot> {
  // Load wallet (chain-aware)
  const { account, chainIdentity, chainType: walletChainType } = await getWallet();
  const resolvedChainType = config.chainType || walletChainType || "evm";
  const apiKey = config.conwayApiKey || loadApiKeyFromConfig();
  if (!apiKey) {
    logger.error("No API key found. Run: automaton --provision");
    process.exit(1);
  }

  // Persist createdAt: only set if not already stored (never overwrite)
  const existingCreatedAt = db.getIdentity("createdAt");
  const createdAt = existingCreatedAt || new Date().toISOString();
  if (!existingCreatedAt) {
    db.setIdentity("createdAt", createdAt);
  }

  const identity: AutomatonIdentity = {
    name: config.name,
    address: chainIdentity.address,
    account,
    creatorAddress: config.creatorAddress,
    sandboxId: config.sandboxId,
    apiKey,
    createdAt,
    chainType: resolvedChainType,
    chainIdentity,
  };

  db.setIdentity("name", config.name);
  db.setIdentity("address", chainIdentity.address);
  db.setIdentity("creator", config.creatorAddress);
  db.setIdentity("chainType", resolvedChainType);
  db.setIdentity("sandbox", config.sandboxId);
  const storedAutomatonId = db.getIdentity("automatonId");
  const automatonId = storedAutomatonId || config.sandboxId || randomUUID();
  if (!storedAutomatonId) {
    db.setIdentity("automatonId", automatonId);
  }

  const conway = createConwayClient({
    apiUrl: config.conwayApiUrl,
    apiKey,
    sandboxId: config.sandboxId,
  });

  // Register automaton identity (one-time, immutable)
  const registrationState = db.getIdentity("conwayRegistrationStatus");
  if (registrationState !== "registered") {
    try {
      const genesisPromptHash = config.genesisPrompt
        ? keccak256(toHex(config.genesisPrompt))
        : undefined;
      await conway.registerAutomaton({
        automatonId,
        automatonAddress: chainIdentity.address,
        creatorAddress: config.creatorAddress,
        name: config.name,
        bio: config.creatorMessage || "",
        genesisPromptHash,
        account,
        chainType: resolvedChainType,
        chainIdentity,
      });
      db.setIdentity("conwayRegistrationStatus", "registered");
      logger.info(`[${new Date().toISOString()}] Automaton identity registered.`);
    } catch (err: any) {
      const status = err?.status;
      if (status === 409) {
        db.setIdentity("conwayRegistrationStatus", "conflict");
        logger.warn(`[${new Date().toISOString()}] Automaton identity conflict: ${err.message}`);
      } else {
        db.setIdentity("conwayRegistrationStatus", "failed");
        logger.warn(`[${new Date().toISOString()}] Automaton identity registration failed: ${err.message}`);
      }
    }
  }

  return { kind: "conway", identity, conway, ledger: undefined, account, chainIdentity, chainType: resolvedChainType };
}

// ─── Bootstrap: local mode (fork default) ─────────────────────

function bootstrapLocal(config: AutomatonConfig, db: AutomatonDatabase): LocalBoot {
  const localConfig = config.local ?? DEFAULT_LOCAL_CONFIG;
  const identity = createLocalIdentity(db, config);
  const ledger = new Ledger(db.raw);
  const conway = createLocalProvider({
    ledger,
    workspaceDir: resolvePath(localConfig.workspaceDir),
    execTarget:
      localConfig.execTarget === "docker"
        ? { kind: "docker", container: localConfig.dockerContainer || "automaton" }
        : { kind: "host" },
  });
  return { kind: "local", identity, conway, ledger };
}

// WHY: these tasks poll USDC, the social relay and Conway's upstream repo.
// None exist in local mode, so they are disabled rather than left to fail.
const CONWAY_ONLY_HEARTBEAT_TASKS = new Set(["check_usdc_balance", "check_social_inbox", "check_for_updates"]);

function disableConwayHeartbeatEntries(heartbeatConfig: HeartbeatConfig): void {
  for (const entry of heartbeatConfig.entries) {
    if (CONWAY_ONLY_HEARTBEAT_TASKS.has(entry.task)) {
      entry.enabled = false;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Entry Point ───────────────────────────────────────────────

main().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
