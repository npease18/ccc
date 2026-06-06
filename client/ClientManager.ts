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

        console.log(`Connected as directory '${this.directoryName}' (${this.cwd})`);
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
                console.error(
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
            console.log("Disconnected from orchestrator.");
        });

        this.socket.on("error", (error) => {
            console.error("Socket error:", error.message);
        });
    }

    private handleIncomingLine(line: string): void {
        let message: OrchestratorToClientMessage;

        try {
            message = JSON.parse(line) as OrchestratorToClientMessage;
        } catch {
            console.log(`Unparseable message: ${line}`);
            return;
        }

        if (message.type === "welcome") {
            console.log(`Assigned client ID: ${message.clientId}`);
            return;
        }

        if (message.type === "rpc_request") {
            void this.handleRpcRequest(message.requestId, message.request);
            return;
        }

        if (message.type === "error") {
            console.error(`Server error: ${message.error}`);
        }
    }

    private async handleRpcRequest(requestId: string, request: ClientRpcRequest): Promise<void> {
        try {
            if (request.action === "read_file") {
                const result = await this.readLocalFile(request.filePath);
                this.send({
                    type: "rpc_response",
                    requestId,
                    ok: true,
                    result,
                });
                return;
            }

            if (request.action === "run_command") {
                const result = await this.runLocalCommand(requestId, request.command, request.timeoutMs);
                this.send({
                    type: "rpc_response",
                    requestId,
                    ok: true,
                    result,
                });
                return;
            }

            if (request.action === "kill_command") {
                const result = this.killActiveCommand(request.targetRequestId);
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
                const result = await this.listLocalFiles(request.relativePath);
                this.send({
                    type: "rpc_response",
                    requestId,
                    ok: true,
                    result,
                });
            }
        } catch (error) {
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
                    childProcess.kill("SIGTERM");
                }, timeoutMs);
            }

            this.activeCommands.set(requestId, activeCommand);

            childProcess.stdout.on("data", (chunk: Buffer | string) => {
                this.send({
                    type: "rpc_stream",
                    requestId,
                    stream: "stdout",
                    chunk: chunk.toString("utf8"),
                });
            });

            childProcess.stderr.on("data", (chunk: Buffer | string) => {
                this.send({
                    type: "rpc_stream",
                    requestId,
                    stream: "stderr",
                    chunk: chunk.toString("utf8"),
                });
            });

            childProcess.once("error", (error) => {
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
        this.socket.write(`${JSON.stringify(message)}\n`);
    }

    static Start(): void {
        const client = new ClientManager();
        void client.start().catch((error) => {
            console.error("Failed to start client:", error);
        });
    }
}