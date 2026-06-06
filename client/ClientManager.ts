import net from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { readdir } from "node:fs/promises";
import type { Readable } from "node:stream";
import type {
    CommandCompletionResult,
    ClientRpcRequest,
    ClientToOrchestratorMessage,
    OrchestratorToClientMessage,
} from "../types/orchestrator.ts";

const DEFAULT_COMMAND_TIMEOUT_MS = 30000;
const MAX_FILE_BYTES = 200_000;
const CONNECT_RETRY_DELAY_MS = 1500;
const MAX_CONNECT_RETRIES = 0;

// Logging configuration
const VERBOSE_LOGGING = process.env.ORCH_VERBOSE === "true";

type LogLevel = "info" | "debug" | "error" | "warn";

class Logger {
    log(level: LogLevel, message: string, data?: unknown): void {
        const timestamp = new Date().toISOString();
        const prefix = `[${timestamp}] [${level.toUpperCase()}]`;

        if (level === "error") {
            console.error(`${prefix}`, message, data);
        } else if (VERBOSE_LOGGING || level === "warn") {
            console.log(`${prefix}`, message, data ? JSON.stringify(data, null, 2) : "");
        }
    }

    info(message: string, data?: unknown): void {
        this.log("info", message, data);
    }

    debug(message: string, data?: unknown): void {
        this.log("debug", message, data);
    }

    warn(message: string, data?: unknown): void {
        this.log("warn", message, data);
    }

    error(message: string, data?: unknown): void {
        this.log("error", message, data);
    }
}

const logger = new Logger();
type ActiveCommand = {
    childProcess: ChildProcessByStdio<null, Readable, Readable>;
    command: string;
    timeout: Timer | null;
    killed: boolean;
    timedOut: boolean;
};

type ClientConfig = {
    host: string;
    port: number;
};

export class ClientManager {
    private readonly config: ClientConfig;
    private readonly socket: net.Socket;
    private readonly activeCommands: Map<string, ActiveCommand>;
    private buffer: string;
    private readonly directoryName: string;
    private readonly cwd: string;

    constructor(config: ClientConfig = {
        host: process.env.ORCH_HOST ?? "127.0.0.1",
        port: Number(process.env.ORCH_PORT ?? "9000"),
    }) {
        this.config = config;
        this.socket = new net.Socket();
        this.activeCommands = new Map<string, ActiveCommand>();
        this.buffer = "";
        this.cwd = process.cwd();
        this.directoryName = path.basename(this.cwd);
    }

    async start(): Promise<void> {
        await this.connectWithRetry();
        this.attachSocketHandlers();
        this.send({
            type: "hello",
            directoryName: this.directoryName,
            cwd: this.cwd,
        });

        logger.info(`Connected as directory '${this.directoryName}' (${this.cwd})`);
        logger.debug(`Verbose logging is ${VERBOSE_LOGGING ? "ENABLED" : "DISABLED"}. Set ORCH_VERBOSE=true to enable.`);
    }

    private async connectWithRetry(): Promise<void> {
        let attempt = 0;

        while (true) {
            attempt += 1;

            try {
                await this.connect();
                return;
            } catch (error) {
                const shouldRetry = MAX_CONNECT_RETRIES === 0 || attempt < MAX_CONNECT_RETRIES;

                if (!shouldRetry) {
                    throw error;
                }

                const message = error instanceof Error ? error.message : "Unknown connect error.";
                logger.error(
                    `Connect attempt ${attempt} failed (${message}). Retrying in ${CONNECT_RETRY_DELAY_MS}ms...`,
                );

                await new Promise<void>((resolve) => {
                    setTimeout(resolve, CONNECT_RETRY_DELAY_MS);
                });
            }
        }
    }

    private async connect(): Promise<void> {
        await new Promise<void>((resolve, reject) => {
            this.socket.once("error", reject);
            this.socket.connect(this.config.port, this.config.host, () => {
                this.socket.off("error", reject);
                resolve();
            });
        });
    }

    private attachSocketHandlers(): void {
        this.socket.on("data", (chunk) => {
            this.buffer += chunk.toString("utf8");

            while (this.buffer.includes("\n")) {
                const splitIndex = this.buffer.indexOf("\n");
                const line = this.buffer.slice(0, splitIndex).trim();
                this.buffer = this.buffer.slice(splitIndex + 1);

                if (!line) {
                    continue;
                }

                this.handleIncomingLine(line);
            }
        });

        this.socket.on("close", () => {
            this.killAllActiveCommands();
            logger.warn("Disconnected from orchestrator.");
        });

        this.socket.on("error", (error) => {
            logger.error("Socket error:", { message: error.message });
        });
    }

    private handleIncomingLine(line: string): void {
        let message: OrchestratorToClientMessage;

        try {
            message = JSON.parse(line) as OrchestratorToClientMessage;
        } catch {
            logger.error(`Unparseable message: ${line}`);
            return;
        }

        if (message.type === "welcome") {
            logger.info(`Assigned client ID: ${message.clientId}`);
            return;
        }

        if (message.type === "rpc_request") {
                        logger.debug(`Received RPC request`, { requestId: message.requestId, request: message.request });
            void this.handleRpcRequest(message.requestId, message.request);
            return;
        }

        if (message.type === "error") {
            logger.error(`Server error: ${message.error}`);
        }
    }

    private async handleRpcRequest(requestId: string, request: ClientRpcRequest): Promise<void> {
        try {
            if (request.action === "read_file") {
                                logger.debug(`[${requestId}] Handling read_file request`, { filePath: request.filePath });
                const result = await this.readLocalFile(request.filePath);
                                logger.debug(`[${requestId}] Read file completed`, {
                                    filePath: request.filePath,
                                    contentLength: result.content.length,
                                    truncated: result.truncated,
                                });
                this.send({
                    type: "rpc_response",
                    requestId,
                    ok: true,
                    result,
                });
                return;
            }

            if (request.action === "run_command") {
                                logger.debug(`[${requestId}] Handling run_command request`, { command: request.command, timeoutMs: request.timeoutMs });
                const result = await this.runLocalCommand(requestId, request.command, request.timeoutMs);
                                logger.debug(`[${requestId}] Command completed`, {
                                    command: request.command,
                                    exitCode: result.exitCode,
                                    signal: result.signal,
                                    timedOut: result.timedOut,
                                });
                this.send({
                    type: "rpc_response",
                    requestId,
                    ok: true,
                    result,
                });
                return;
            }

            if (request.action === "kill_command") {
                                logger.debug(`[${requestId}] Handling kill_command request`, { targetRequestId: request.targetRequestId });
                const result = this.killActiveCommand(request.targetRequestId);
                                logger.debug(`[${requestId}] Kill command result`, { ok: result.ok, error: result.ok ? undefined : result.error });
                this.send({
                    type: "rpc_response",
                    requestId,
                    ok: result.ok,
                    result: result.ok ? result : undefined,
                    error: result.ok ? undefined : result.error,
                });
                return;
            }

            if (request.action === "list_files") {
                logger.debug(`[${requestId}] Handling list_files request`, { relativePath: request.relativePath });
                const result = await this.listLocalFiles(request.relativePath);
                logger.debug(`[${requestId}] List files completed`, { basePath: result.basePath, entryCount: result.entries.length });
                this.send({
                    type: "rpc_response",
                    requestId,
                    ok: true,
                    result,
                });
            }
        } catch (error) {
            logger.error(`[${requestId}] Request handler error`, {
                action: request.action,
                message: error instanceof Error ? error.message : "Unknown error",
                stack: VERBOSE_LOGGING && error instanceof Error ? error.stack : undefined,
            });
            this.send({
                type: "rpc_response",
                requestId,
                ok: false,
                error: error instanceof Error ? error.message : "Unknown client error.",
            });
        }
    }

    private async listLocalFiles(relativePath?: string): Promise<{ basePath: string; entries: { name: string; type: "file" | "directory" | "other" }[] }> {
        const targetPath = this.resolveUnderCwd(relativePath ?? ".");
        const entries = await readdir(targetPath, { withFileTypes: true });

        return {
            basePath: targetPath,
            entries: entries.map((entry) => ({
                name: entry.name,
                type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
            })),
        };
    }

    private resolveUnderCwd(relativePath: string): string {
        const resolvedPath = path.resolve(this.cwd, relativePath);
        const cwdWithSeparator = this.cwd.endsWith(path.sep) ? this.cwd : `${this.cwd}${path.sep}`;

        if (resolvedPath !== this.cwd && !resolvedPath.startsWith(cwdWithSeparator)) {
            throw new Error("Path escapes client working directory.");
        }

        return resolvedPath;
    }

    private async readLocalFile(filePath: string): Promise<{ resolvedPath: string; content: string; truncated: boolean }> {
        const resolvedPath = this.resolveUnderCwd(filePath);
        const data = await readFile(resolvedPath);
        const truncated = data.byteLength > MAX_FILE_BYTES;
        const contentBuffer = truncated ? data.subarray(0, MAX_FILE_BYTES) : data;

        return {
            resolvedPath,
            content: contentBuffer.toString("utf8"),
            truncated,
        };
    }

    private async runLocalCommand(
        requestId: string,
        command: string,
        timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
    ): Promise<CommandCompletionResult> {
        return new Promise<CommandCompletionResult>((resolve, reject) => {
                        logger.debug(`[${requestId}] Spawning command`, { command, cwd: this.cwd, timeoutMs });
            const childProcess = spawn("/bin/sh", ["-lc", command], {
                cwd: this.cwd,
                env: process.env,
                stdio: ["ignore", "pipe", "pipe"],
            });

            const activeCommand: ActiveCommand = {
                childProcess,
                command,
                timeout: null,
                killed: false,
                timedOut: false,
            };

            if (timeoutMs > 0) {
                activeCommand.timeout = setTimeout(() => {
                    activeCommand.timedOut = true;
                    activeCommand.killed = true;
                                        logger.warn(`[${requestId}] Command timeout after ${timeoutMs}ms`, { command });
                    childProcess.kill("SIGTERM");
                }, timeoutMs);
            }

            this.activeCommands.set(requestId, activeCommand);

            childProcess.stdout.on("data", (chunk: Buffer | string) => {
                                const chunkStr = chunk.toString("utf8");
                                if (VERBOSE_LOGGING) {
                                    logger.debug(`[${requestId}] stdout chunk`, { length: chunkStr.length, preview: chunkStr.slice(0, 100) });
                                }
                this.send({
                    type: "rpc_stream",
                    requestId,
                    stream: "stdout",
                    chunk: chunkStr,
                });
            });

            childProcess.stderr.on("data", (chunk: Buffer | string) => {
                                const chunkStr = chunk.toString("utf8");
                                logger.debug(`[${requestId}] stderr chunk`, { length: chunkStr.length, preview: chunkStr.slice(0, 100) });
                this.send({
                    type: "rpc_stream",
                    requestId,
                    stream: "stderr",
                    chunk: chunkStr,
                });
            });

            childProcess.once("error", (error) => {
                                logger.error(`[${requestId}] Child process error`, { message: error.message });
                this.clearActiveCommand(requestId);
                reject(error);
            });

            childProcess.once("close", (exitCode, signal) => {
                const finalState = this.activeCommands.get(requestId) ?? activeCommand;
                this.clearActiveCommand(requestId);

                resolve({
                    command,
                    cwd: this.cwd,
                    exitCode,
                    signal,
                    timedOut: finalState.timedOut,
                    killed: finalState.killed,
                });
            });
        });
    }

    private killActiveCommand(requestId: string): { ok: true; commandId: string } | { ok: false; error: string } {
        const activeCommand = this.activeCommands.get(requestId);

        if (!activeCommand) {
            return {
                ok: false,
                error: `No active command found for request: ${requestId}`,
            };
        }

        activeCommand.killed = true;
        activeCommand.childProcess.kill("SIGTERM");

        return {
            ok: true,
            commandId: requestId,
        };
    }

    private killAllActiveCommands(): void {
        for (const [requestId, activeCommand] of this.activeCommands) {
            activeCommand.killed = true;
            activeCommand.childProcess.kill("SIGTERM");
            this.clearActiveCommand(requestId);
        }
    }

    private clearActiveCommand(requestId: string): void {
        const activeCommand = this.activeCommands.get(requestId);

        if (!activeCommand) {
            return;
        }

        if (activeCommand.timeout) {
            clearTimeout(activeCommand.timeout);
        }

        this.activeCommands.delete(requestId);
    }

    private send(message: ClientToOrchestratorMessage): void {
                if (message.type === "hello") {
                    logger.info(`Sending hello message`, { directoryName: message.directoryName, cwd: message.cwd });
                } else if (message.type === "rpc_response") {
                    logger.debug(`Sending RPC response`, { requestId: message.requestId, ok: message.ok, hasError: !!message.error });
                } else if (message.type === "rpc_stream") {
                    if (VERBOSE_LOGGING) {
                        logger.debug(`Sending RPC stream chunk`, { requestId: message.requestId, stream: message.stream, chunkLength: message.chunk?.length ?? 0 });
                    }
                }
        this.socket.write(`${JSON.stringify(message)}\n`);
    }

    static Start(): void {
        const client = new ClientManager();
        void client.start().catch((error) => {
            console.error("Failed to start client:", error);
        });
    }
}