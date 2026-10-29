/**
 * Local Mode Setup Wizard
 *
 * First-run setup for an automaton that lives on the creator's machine:
 * no wallet, no Conway, inference through the creator's own Anthropic key,
 * and a USD budget the creator funds by hand.
 */

import fs from "fs";
import path from "path";
import chalk from "chalk";
import { showBanner } from "./banner.js";
import { promptRequired, promptOptional, promptMultiline, promptWithDefault, closePrompts } from "./prompts.js";
import { generateSoulMd, installDefaultSkills } from "./defaults.js";
import { saveConfig, resolvePath } from "../config.js";
import { getAutomatonDir } from "../identity/wallet.js";
import { createDatabase } from "../state/database.js";
import { Ledger } from "../local/ledger.js";
import type { AutomatonConfig } from "../types.js";
import {
  DEFAULT_CONFIG,
  DEFAULT_TREASURY_POLICY,
  DEFAULT_MODEL_STRATEGY_CONFIG,
  DEFAULT_SOUL_CONFIG,
  DEFAULT_APPROVAL_CONFIG,
  DEFAULT_LOCAL_CONFIG,
} from "../types.js";

export async function runLocalSetupWizard(): Promise<AutomatonConfig> {
  showBanner();
  console.log(chalk.white("  First-run setup (local mode). No wallet, no crypto: you are the bank.\n"));

  // ─── 1. Identity ─────────────────────────────────────────────
  console.log(chalk.cyan("  [1/4] Identity\n"));
  const name = await promptRequired("Automaton name");
  const creatorName = await promptRequired("Your name (creator)");
  console.log(chalk.white("\n  Genesis prompt: the seed instruction. Be concrete about what it should build and sell."));
  const genesisPrompt = await promptMultiline("Genesis prompt");
  const creatorMessage = await promptOptional("Message to your automaton (optional)");

  // ─── 2. Inference ────────────────────────────────────────────
  console.log(chalk.cyan("\n  [2/4] Inference\n"));
  const envKey = process.env.ANTHROPIC_API_KEY;
  let anthropicApiKey = envKey || "";
  if (envKey) {
    console.log(chalk.green("  Using ANTHROPIC_API_KEY from the environment."));
  } else {
    anthropicApiKey = await promptRequired("Anthropic API key (sk-ant-...)");
    if (!anthropicApiKey.startsWith("sk-ant-")) {
      console.log(chalk.yellow("  Warning: key does not look like an Anthropic key."));
    }
  }

  // ─── 3. Budget and execution ─────────────────────────────────
  console.log(chalk.cyan("\n  [3/4] Budget and execution\n"));
  const initialBudgetCents = await promptWithDefault("Initial budget (cents)", 1000);
  const execInput = await promptOptional("Run commands on host or docker? [host]");
  const execTarget = execInput.toLowerCase() === "docker" ? "docker" : "host";
  let dockerContainer: string | undefined;
  if (execTarget === "docker") {
    dockerContainer = (await promptOptional("Docker container name [automaton]")) || "automaton";
  } else {
    console.log(chalk.yellow("  Commands will run on this machine. Every risky tool call waits for your approval."));
  }

  // ─── 4. Write configuration ──────────────────────────────────
  console.log(chalk.cyan("\n  [4/4] Writing configuration...\n"));
  const dir = getAutomatonDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const config: AutomatonConfig = {
    ...(DEFAULT_CONFIG as AutomatonConfig),
    name,
    genesisPrompt,
    creatorMessage: creatorMessage || undefined,
    creatorAddress: creatorName,
    registeredWithConway: false,
    sandboxId: "",
    conwayApiKey: "",
    anthropicApiKey,
    walletAddress: "",
    inferenceModel: DEFAULT_MODEL_STRATEGY_CONFIG.inferenceModel,
    maxTokensPerTurn: DEFAULT_MODEL_STRATEGY_CONFIG.maxTokensPerTurn,
    treasuryPolicy: DEFAULT_TREASURY_POLICY,
    modelStrategy: DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: DEFAULT_SOUL_CONFIG,
    approval: DEFAULT_APPROVAL_CONFIG,
    runtimeMode: "local",
    local: { ...DEFAULT_LOCAL_CONFIG, execTarget, dockerContainer },
    socialRelayUrl: undefined,
  };
  saveConfig(config);
  console.log(chalk.green(`  Config written: ${path.join(dir, "automaton.json")}`));

  const soulPath = path.join(dir, "SOUL.md");
  if (!fs.existsSync(soulPath)) {
    fs.writeFileSync(soulPath, generateSoulMd(name, "local", creatorName, genesisPrompt), { mode: 0o600 });
    console.log(chalk.green("  SOUL.md written."));
  }
  try {
    installDefaultSkills(resolvePath(config.skillsDir));
  } catch (err: any) {
    console.log(chalk.yellow(`  Default skills not installed: ${err.message}`));
  }

  if (initialBudgetCents > 0) {
    const db = createDatabase(resolvePath(config.dbPath));
    new Ledger(db.raw).credit(initialBudgetCents, "initial budget", "setup");
    db.close();
    console.log(chalk.green(`  Ledger funded: $${(initialBudgetCents / 100).toFixed(2)}`));
  }

  console.log(chalk.white(`\n  Approval dashboard will listen on http://127.0.0.1:${config.approval?.dashboardPort ?? 7777}`));
  console.log(chalk.white("  Add funds later with: automaton --fund <usd>\n"));
  closePrompts();
  return config;
}
