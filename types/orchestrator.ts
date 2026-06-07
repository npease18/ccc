export type RpcAction = "read_file" | "read_file_chunk" | "run_command" | "list_files" | "kill_command";

export type ClientRpcRequest =
    | {
        action: "read_file";
        filePath: string;
      }
    | {
        action: "read_file_chunk";
        filePath: string;
        offset: number;
        length: number;
      }
    | {
        action: "run_command";
        command: string;
        timeoutMs?: number;
      }
    | {
        action: "list_files";
        relativePath?: string;
      }
    | {
      action: "kill_command";
      targetRequestId: string;
      };

  export type CommandStreamMessage = {
    requestId: string;
    stream: "stdout" | "stderr";
    chunk: string;
  };

  export type CommandCompletionResult = {
    command: string;
    cwd: string;
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    killed: boolean;
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
      }
    | ({
        type: "rpc_stream";
      } & CommandStreamMessage);

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
