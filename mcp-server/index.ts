#!/usr/bin/env bun

import { McpOrchestratorServer } from "./McpOrchestratorServer.ts";

const server = new McpOrchestratorServer({
    name: "ccc-mcp-orchestrator",
    version: "1.0.0",
});

const shutdown = async () => {
    await server.stop();
    process.exit(0);
};

process.once("SIGINT", () => {
    void shutdown();
});

process.once("SIGTERM", () => {
    void shutdown();
});

void server.start().catch((error) => {
    console.error("Failed to start MCP orchestrator server:", error);
    process.exit(1);
});
