export type RpcAction = "read_file" | "run_command" | "list_files";

export type ClientRpcRequest =
    | {
        action: "read_file";
        filePath: string;
      }
    | {
        action: "run_command";
        command: string;
        timeoutMs?: number;
      }
    | {
        action: "list_files";
        relativePath?: string;
      };

export type ClientToOrchestratorMessage =
    | {
        type: "hello";
        directoryName: string;
        cwd: string;
      }
    | {
        type: "rpc_response";
        requestId: string;
        ok: boolean;
        result?: unknown;
        error?: string;
      };

export type OrchestratorToClientMessage =
    | {
        type: "welcome";
        clientId: string;
      }
    | {
        type: "rpc_request";
        requestId: string;
        request: ClientRpcRequest;
      }
    | {
        type: "error";
        error: string;
      };

export type OrchestratorConfig = {
    host: string;
    port: number;
};

export type RegisteredClient = {
  clientId: string;
  directoryName: string;
  cwd: string;
};
