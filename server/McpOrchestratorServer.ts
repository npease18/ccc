import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import {
    CallToolRequestSchema,
    type Implementation,
    type ServerNotification,
    type ServerRequest,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Orchestrator } from "./Orchestrator.ts";

type JsonSchema = {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
};

type ToolDefinition = {
    name: string;
    description: string;
    inputSchema: JsonSchema;
    run: (
        args: Record<string, unknown> | undefined,
        extra: RequestHandlerExtra<ServerRequest, ServerNotification>,
    ) => Promise<unknown>;
};

export class McpOrchestratorServer {
    private readonly server: Server;
    private readonly orchestrator: Orchestrator;
    private readonly tools: Map<string, ToolDefinition>;
    private transport: StdioServerTransport | null;

    constructor(serverInfo: Implementation = { name: "ccc-mcp-orchestrator", version: "1.0.0" }) {
        this.server = new Server(serverInfo, {
            capabilities: { tools: {} },
        });
        this.orchestrator = new Orchestrator({ host: "0.0.0.0", port: 9000 });
        this.tools = new Map<string, ToolDefinition>();
        this.transport = null;

        this.registerDefaultTools();
        this.registerRequestHandlers();
    }

    async start(): Promise<void> {
        await this.orchestrator.start();

        this.transport = new StdioServerTransport();
        await this.server.connect(this.transport);

        console.error("MCP orchestrator server started.");
    }

    async stop(): Promise<void> {
        await this.server.close();

        if (this.transport) {
            await this.transport.close();
            this.transport = null;
        }

        await this.orchestrator.stop();
        console.error("MCP orchestrator server stopped.");
    }

    private registerDefaultTools(): void {
        this.registerTool({
            name: "list_clients",
            description: "List connected clients grouped by their declared directory name.",
            inputSchema: {
                type: "object",
                properties: {},
            },
            run: async () => {
                const groupedClients = this.orchestrator.listClientsByDirectory();
                const totalClients = Object.values(groupedClients).reduce((count, group) => count + group.length, 0);

                return {
                    totalClients,
                    groupedClients,
                };
            },
        });

        this.registerTool({
            name: "get_client_file",
            description: "Read a file from one connected client directory and return it as context.",
            inputSchema: {
                type: "object",
                properties: {
                    directoryName: { type: "string" },
                    filePath: { type: "string" },
                },
                required: ["directoryName", "filePath"],
            },
            run: async (args) => {
                const directoryName = this.readString(args, "directoryName");
                const filePath = this.readString(args, "filePath");
                const result = await this.orchestrator.readFileFromDirectory(directoryName, filePath);

                return {
                    directoryName,
                    filePath,
                    result,
                };
            },
        });

        this.registerTool({
            name: "get_client_file_chunk",
            description:
                "Read a specific byte range of a file from one connected client directory. " +
                "Use this to page through large files that exceed what get_client_file can return at once. " +
                "The response includes totalBytes and hasMore so you know when to stop reading.",
            inputSchema: {
                type: "object",
                properties: {
                    directoryName: { type: "string" },
                    filePath: { type: "string" },
                    offset: { type: "number", description: "Byte offset to start reading from (default 0)." },
                    length: { type: "number", description: "Maximum number of bytes to read (default 100000)." },
                },
                required: ["directoryName", "filePath"],
            },
            run: async (args) => {
                const directoryName = this.readString(args, "directoryName");
                const filePath = this.readString(args, "filePath");
                const offset = this.readNumber(args, "offset", 0);
                const length = this.readNumber(args, "length", 100_000);
                const result = await this.orchestrator.readFileChunkFromDirectory(directoryName, filePath, offset, length);

                return {
                    directoryName,
                    filePath,
                    result,
                };
            },
        });

        this.registerTool({
            name: "edit_client_file",
            description: "Write (create or overwrite) a file on one connected client directory. Parent directories are created automatically.",
            inputSchema: {
                type: "object",
                properties: {
                    directoryName: { type: "string" },
                    filePath: { type: "string" },
                    content: { type: "string", description: "Full content to write to the file." },
                },
                required: ["directoryName", "filePath", "content"],
            },
            run: async (args) => {
                const directoryName = this.readString(args, "directoryName");
                const filePath = this.readString(args, "filePath");
                const content = this.readString(args, "content");
                const result = await this.orchestrator.writeFileOnDirectory(directoryName, filePath, content);

                return {
                    directoryName,
                    filePath,
                    result,
                };
            },
        });

        this.registerTool({
            name: "run_client_command",
            description: "Run a shell command on one connected client directory and return stdout/stderr.",
            inputSchema: {
                type: "object",
                properties: {
                    directoryName: { type: "string" },
                    command: { type: "string" },
                    timeoutMs: { type: "number" },
                },
                required: ["directoryName", "command"],
            },
            run: async (args, extra) => {
                const directoryName = this.readString(args, "directoryName");
                const command = this.readString(args, "command");
                const timeoutMs = this.readNumber(args, "timeoutMs", 30000);
                const result = await this.orchestrator.runCommandOnDirectoryWithOptions(directoryName, command, {
                    timeoutMs,
                    signal: extra.signal,
                    onChunk: (stream, chunk) => {
                        void this.server.sendLoggingMessage({
                            _meta: extra._meta,
                            level: stream === "stderr" ? "warning" : "info",
                            logger: "client-command",
                            data: {
                                directoryName,
                                stream,
                                chunk,
                            },
                        }, extra.sessionId);
                    },
                });

                return {
                    directoryName,
                    command,
                    result,
                };
            },
        });

        this.registerTool({
            name: "get_client_cwd_files",
            description: "List files and directories from a client directory to help select context files.",
            inputSchema: {
                type: "object",
                properties: {
                    directoryName: { type: "string" },
                    relativePath: { type: "string" },
                },
                required: ["directoryName"],
            },
            run: async (args) => {
                const directoryName = this.readString(args, "directoryName");
                const relativePath = this.readOptionalString(args, "relativePath");
                const result = await this.orchestrator.listFilesOnDirectory(directoryName, relativePath);

                return {
                    directoryName,
                    relativePath: relativePath ?? ".",
                    result,
                };
            },
        });
    }

    private registerTool(tool: ToolDefinition): void {
        this.tools.set(tool.name, tool);
    }

    private registerRequestHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: Array.from(this.tools.values()).map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                })),
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
            const tool = this.tools.get(request.params.name);

            if (!tool) {
                return {
                    content: [{ type: "text", text: `Tool not found: ${request.params.name}` }],
                    isError: true,
                };
            }

            try {
                const result = await tool.run(request.params.arguments, extra);
                return {
                    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
                };
            } catch (error) {
                return {
                    content: [{ type: "text", text: this.formatError(error) }],
                    isError: true,
                };
            }
        });
    }

    private readString(args: Record<string, unknown> | undefined, key: string): string {
        const value = args?.[key];

        if (typeof value !== "string" || value.trim() === "") {
            throw new Error(`Expected non-empty string argument: ${key}`);
        }

        return value;
    }

    private readNumber(args: Record<string, unknown> | undefined, key: string, defaultValue: number): number {
        const value = args?.[key];

        if (value === undefined) {
            return defaultValue;
        }

        if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
            throw new Error(`Expected positive number argument: ${key}`);
        }

        return value;
    }

    private readOptionalString(args: Record<string, unknown> | undefined, key: string): string | undefined {
        const value = args?.[key];

        if (value === undefined) {
            return undefined;
        }

        if (typeof value !== "string") {
            throw new Error(`Expected string argument: ${key}`);
        }

        return value;
    }

    private formatError(error: unknown): string {
        if (error instanceof Error) {
            return error.message;
        }

        return "Unknown error.";
    }
}
