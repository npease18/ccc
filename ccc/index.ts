#!/usr/bin/env bun

import { ServerManager } from "./mode/server/ServerManager.ts";
import { ClientManager } from "./mode/client/ClientManager.ts";

type OperatingMode = "server" | "client";

const MODE_PROMPT = [
  "Select operating mode:",
  "  1) Server / Orchestrator",
  "  2) Client",
  "",
  "Enter choice (1/2, server/client): "
].join("\n");

function parseMode(input: string): OperatingMode | null {
  const normalized = input.trim().toLowerCase();

  if (["1", "server", "orchestrator", "s", "o"].includes(normalized)) {
    return "server";
  }

  if (["2", "client", "c"].includes(normalized)) {
    return "client";
  }

  return null;
}

async function askForMode(): Promise<OperatingMode> {
  while (true) {
    const input = prompt(MODE_PROMPT) ?? "";
    const mode = parseMode(input);

    if (mode) {
      return mode;
    }

    console.log("Invalid selection. Please choose Server / Orchestrator or Client.\n");
  }
}

async function main(): Promise<void> {
  const mode = await askForMode();

  if (mode === "server") {
    ServerManager.Start();
    return;
  } else {
    ClientManager.Start();
  }
}

main()