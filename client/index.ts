#!/usr/bin/env bun

import { ClientManager } from "./ClientManager.ts";
import { printVersion } from "../version.ts";

if (process.argv.includes("-v") || process.argv.includes("--version")) {
    printVersion("ccc-client");
    process.exit(0);
}

ClientManager.Start();
