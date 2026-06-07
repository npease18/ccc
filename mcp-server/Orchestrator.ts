import net from "node:net";
import { randomUUID } from "node:crypto";
import type {
    CommandCompletionResult,
    ClientRpcRequest,
    ClientToOrchestratorMessage,
    OrchestratorConfig,
    OrchestratorToClientMessage,
    RegisteredClient,
} from "../types/orchestrator.ts";

type ClientState = {
    clientId: string;
    socket: net.Socket;
    buffer: string;
    directoryName: string | null;
    cwd: string | null;
};

type PendingRequest = {
    requestId: string;
    clientId: string;
    resolve: (value: unknown) => void;
    reject: (reason?: unknown) => void;
    timeout: Timer;
    kind: "default" | "command";
    stdout: string;
    stderr: string;
    onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
    abortCleanup?: () => void;
};

export class Orchestrator {
    private readonly config: OrchestratorConfig;
    private readonly clients: Map<string, ClientState>;
    private readonly pendingRequests: Map<string, PendingRequest>;
    private server: net.Server | null;
    private nextClientId: number;

    constructor(config: OrchestratorConfig = { host: "0.0.0.0", port: 9000 }) {
        this.config = config;
        this.clients = new Map<string, ClientState>();
        this.pendingRequests = new Map<string, PendingRequest>();
        this.server = null;
        this.nextClientId = 1;
    }

    async start(): Promise<void> {
        if (this.server) {
            return;
        }

        this.server = net.createServer((socket) => {
            this.handleConnection(socket);
        });

        await new Promise<void>((resolve, reject) => {
            if (!this.server) {
                reject(new Error("TCP server was not initialized."));
                return;
            }

            this.server.once("error", reject);
            this.server.listen(this.config.port, this.config.host, () => {
                this.server?.off("error", reject);
                resolve();
            });
        });

        console.error(`Orchestrator listening on ${this.config.host}:${this.config.port}`);
    }

    async stop(): Promise<void> {
        for (const pendingRequest of this.pendingRequests.values()) {
            clearTimeout(pendingRequest.timeout);
            pendingRequest.reject(new Error("Orchestrator stopped."));
        }
        this.pendingRequests.clear();

        for (const [clientId, state] of this.clients) {
            state.socket.destroy();
            this.clients.delete(clientId);
        }

        if (!this.server) {
            return;
        }

        const closingServer = this.server;
        this.server = null;

        await new Promise<void>((resolve, reject) => {
            closingServer.close((error) => {
                if (error) {
                    reject(error);
                    return;
                }

                resolve();
            });
        });
    }

    listClients(): RegisteredClient[] {
        return Array.from(this.clients.values())
            .filter((client) => client.directoryName !== null && client.cwd !== null)
            .map((client) => ({
                clientId: client.clientId,
                directoryName: client.directoryName as string,
                cwd: client.cwd as string,
            }));
    }

    listClientsByDirectory(): Record<string, RegisteredClient[]> {
        const grouped: Record<string, RegisteredClient[]> = {};

        for (const client of this.listClients()) {
            const existingGroup = grouped[client.directoryName] ?? [];
            existingGroup.push(client);
            grouped[client.directoryName] = existingGroup;
        }

        return grouped;
    }

    async readFileFromDirectory(directoryName: string, filePath: string): Promise<unknown> {
        const client = this.findClientByDirectoryName(directoryName);

        if (!client) {
            throw new Error(`No connected client for directory: ${directoryName}`);
        }

        return this.sendRpcRequest(client.clientId, {
            action: "read_file",
            filePath,
        });
    }

    async runCommandOnDirectory(directoryName: string, command: string, timeoutMs = 30000): Promise<unknown> {
        return this.runCommandOnDirectoryWithOptions(directoryName, command, { timeoutMs });
    }

    async runCommandOnDirectoryWithOptions(
        directoryName: string,
        command: string,
        options: {
            timeoutMs?: number;
            signal?: AbortSignal;
            onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
        } = {},
    ): Promise<unknown> {
        const client = this.findClientByDirectoryName(directoryName);
        const timeoutMs = options.timeoutMs ?? 30000;

        if (!client) {
            throw new Error(`No connected client for directory: ${directoryName}`);
        }

        const requestId = randomUUID();

        return this.sendRpcRequest(client.clientId, {
            action: "run_command",
            command,
            timeoutMs,
        }, {
            requestId,
            timeoutMs: timeoutMs + 3000,
            kind: "command",
            signal: options.signal,
            onChunk: options.onChunk,
        });
    }

    async killCommandOnDirectory(directoryName: string, commandId: string): Promise<unknown> {
        const client = this.findClientByDirectoryName(directoryName);

        if (!client) {
            throw new Error(`No connected client for directory: ${directoryName}`);
        }

        return this.sendRpcRequest(client.clientId, {
            action: "kill_command",
            targetRequestId: commandId,
        });
    }

    async readFileChunkFromDirectory(directoryName: string, filePath: string, offset: number, length: number): Promise<unknown> {
        const client = this.findClientByDirectoryName(directoryName);

        if (!client) {
            throw new Error(`No connected client for directory: ${directoryName}`);
        }

        return this.sendRpcRequest(client.clientId, {
            action: "read_file_chunk",
            filePath,
            offset,
            length,
        });
    }

    async listFilesOnDirectory(directoryName: string, relativePath?: string): Promise<unknown> {
        const client = this.findClientByDirectoryName(directoryName);

        if (!client) {
            throw new Error(`No connected client for directory: ${directoryName}`);
        }

        return this.sendRpcRequest(client.clientId, {
            action: "list_files",
            relativePath,
        });
    }

    private findClientByDirectoryName(directoryName: string): RegisteredClient | null {
        const normalizedDirectoryName = directoryName.trim();

        for (const client of this.listClients()) {
            if (client.directoryName === normalizedDirectoryName) {
                return client;
            }
        }

        return null;
    }

    private async sendRpcRequest(
        clientId: string,
        request: ClientRpcRequest,
        options: {
            requestId?: string;
            timeoutMs?: number;
            kind?: "default" | "command";
            signal?: AbortSignal;
            onChunk?: (stream: "stdout" | "stderr", chunk: string) => void;
        } = {},
    ): Promise<unknown> {
        const state = this.clients.get(clientId);

        if (!state) {
            throw new Error(`Client is not connected: ${clientId}`);
        }

        const requestId = options.requestId ?? randomUUID();
        const timeoutMs = options.timeoutMs ?? 30000;

        return new Promise<unknown>((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`Client request timed out after ${timeoutMs}ms.`));
            }, timeoutMs);

            let abortCleanup: (() => void) | undefined;

            if (options.signal) {
                const onAbort = () => {
                    this.pendingRequests.delete(requestId);
                    clearTimeout(timeout);
                    void this.sendRpcRequest(clientId, {
                        action: "kill_command",
                        targetRequestId: requestId,
                    }, {
                        timeoutMs: 5000,
                    }).catch(() => {
                        return undefined;
                    });
                    reject(new Error("Command cancelled."));
                };

                if (options.signal.aborted) {
                    onAbort();
                    return;
                }

                options.signal.addEventListener("abort", onAbort, { once: true });
                abortCleanup = () => {
                    options.signal?.removeEventListener("abort", onAbort);
                };
            }

            this.pendingRequests.set(requestId, {
                requestId,
                clientId,
                resolve,
                reject,
                timeout,
                kind: options.kind ?? "default",
                stdout: "",
                stderr: "",
                onChunk: options.onChunk,
                abortCleanup,
            });

            this.sendMessage(state.socket, {
                type: "rpc_request",
                requestId,
                request,
            });
        });
    }

    private handleConnection(socket: net.Socket): void {
        const clientId = `client-${this.nextClientId++}`;

        this.clients.set(clientId, {
            clientId,
            socket,
            buffer: "",
            directoryName: null,
            cwd: null,
        });

        this.sendMessage(socket, {
            type: "welcome",
            clientId,
        });

        socket.on("data", (chunk) => {
            this.handleSocketData(clientId, chunk.toString("utf8"));
        });

        socket.on("close", () => {
            this.handleDisconnect(clientId);
        });

        socket.on("error", () => {
            this.handleDisconnect(clientId);
        });
    }

    private handleSocketData(clientId: string, chunk: string): void {
        const state = this.clients.get(clientId);

        if (!state) {
            return;
        }

        state.buffer += chunk;

        while (state.buffer.includes("\n")) {
            const splitIndex = state.buffer.indexOf("\n");
            const line = state.buffer.slice(0, splitIndex).trim();
            state.buffer = state.buffer.slice(splitIndex + 1);

            if (!line) {
                continue;
            }

            this.handleClientLine(clientId, line);
        }
    }

    private handleClientLine(clientId: string, line: string): void {
        const state = this.clients.get(clientId);

        if (!state) {
            return;
        }

        let parsedMessage: ClientToOrchestratorMessage;

        try {
            parsedMessage = JSON.parse(line) as ClientToOrchestratorMessage;
        } catch {
            this.sendMessage(state.socket, {
                type: "error",
                error: "Invalid JSON payload.",
            });
            return;
        }

        if (parsedMessage.type === "hello") {
            const directoryName = parsedMessage.directoryName.trim();

            if (!directoryName) {
                this.sendMessage(state.socket, {
                    type: "error",
                    error: "directoryName must be a non-empty string.",
                });
                return;
            }

            state.directoryName = directoryName;
            state.cwd = parsedMessage.cwd;
            console.error(`Registered ${clientId} as directory '${directoryName}' (${parsedMessage.cwd})`);
            return;
        }

        if (parsedMessage.type === "rpc_response") {
            const pendingRequest = this.pendingRequests.get(parsedMessage.requestId);

            if (!pendingRequest) {
                return;
            }

            this.pendingRequests.delete(parsedMessage.requestId);
            clearTimeout(pendingRequest.timeout);
            pendingRequest.abortCleanup?.();

            if (pendingRequest.clientId !== clientId) {
                pendingRequest.reject(new Error("Response came from unexpected client."));
                return;
            }

            if (!parsedMessage.ok) {
                pendingRequest.reject(new Error(parsedMessage.error ?? "Client reported unknown error."));
                return;
            }

            if (pendingRequest.kind === "command") {
                const commandResult = parsedMessage.result as CommandCompletionResult;

                pendingRequest.resolve({
                    commandId: pendingRequest.requestId,
                    ...commandResult,
                    stdout: pendingRequest.stdout,
                    stderr: pendingRequest.stderr,
                });
                return;
            }

            pendingRequest.resolve(parsedMessage.result);
            return;
        }

        if (parsedMessage.type === "rpc_stream") {
            const pendingRequest = this.pendingRequests.get(parsedMessage.requestId);

            if (!pendingRequest || pendingRequest.kind !== "command") {
                return;
            }

            if (pendingRequest.clientId !== clientId) {
                pendingRequest.reject(new Error("Stream event came from unexpected client."));
                return;
            }

            if (parsedMessage.stream === "stdout") {
                pendingRequest.stdout += parsedMessage.chunk;
            } else {
                pendingRequest.stderr += parsedMessage.chunk;
            }

            pendingRequest.onChunk?.(parsedMessage.stream, parsedMessage.chunk);
        }
    }

    private handleDisconnect(clientId: string): void {
        const state = this.clients.get(clientId);

        if (!state) {
            return;
        }

        for (const [requestId, pendingRequest] of this.pendingRequests) {
            if (pendingRequest.clientId !== clientId) {
                continue;
            }

            this.pendingRequests.delete(requestId);
            clearTimeout(pendingRequest.timeout);
            pendingRequest.abortCleanup?.();
            pendingRequest.reject(new Error(`Client disconnected while request was in flight: ${clientId}`));
        }

        this.clients.delete(clientId);
    }

    private sendMessage(socket: net.Socket, message: OrchestratorToClientMessage): void {
        socket.write(`${JSON.stringify(message)}\n`);
    }
}
