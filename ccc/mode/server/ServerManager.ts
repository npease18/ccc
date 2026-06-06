import { SERVER_TUNNEL_CONFIG } from "../TunnelConfig.ts";

type TunnelSocketData = {
    peer?: Bun.Socket<TunnelSocketData>;
    pendingWrites: Uint8Array[];
    connectionId: number;
    role: "client" | "target";
};

export class ServerManager {
    private static nextConnectionId = 1;

    private constructor() {
        // The manager is started through the static entrypoint.
    }

    private static flushPending(socket: Bun.Socket<TunnelSocketData>): void {
        if (socket.data.pendingWrites.length === 0) {
            return;
        }

        for (const chunk of socket.data.pendingWrites) {
            socket.write(chunk);
        }

        socket.data.pendingWrites = [];
    }

    private static forwardOrQueue(socket: Bun.Socket<TunnelSocketData>, data: Buffer): void {
        const peer = socket.data.peer;

        if (!peer) {
            socket.data.pendingWrites.push(Uint8Array.from(data));
            return;
        }

        peer.write(data);
    }

    private static closePeer(socket: Bun.Socket<TunnelSocketData>): void {
        const peer = socket.data.peer;

        if (peer) {
            socket.data.peer = undefined;
            peer.data.peer = undefined;

            try {
                peer.end();
            } catch {
                // Ignore close errors during shutdown race conditions.
            }
        }
    }

    static Start(): void {
        const listener = Bun.listen<TunnelSocketData>({
            hostname: SERVER_TUNNEL_CONFIG.listenHost,
            port: SERVER_TUNNEL_CONFIG.listenPort,
            socket: {
                open(clientSocket) {
                    const connectionId = ServerManager.nextConnectionId++;
                    clientSocket.data = {
                        pendingWrites: [],
                        connectionId,
                        role: "client"
                    };

                    void Bun.connect<TunnelSocketData>({
                        hostname: SERVER_TUNNEL_CONFIG.targetHost,
                        port: SERVER_TUNNEL_CONFIG.targetPort,
                        data: {
                            pendingWrites: [],
                            connectionId,
                            role: "target",
                            peer: clientSocket
                        },
                        socket: {
                            open(targetSocket) {
                                clientSocket.data.peer = targetSocket;
                                ServerManager.flushPending(clientSocket);
                            },
                            data(targetSocket, data) {
                                ServerManager.forwardOrQueue(targetSocket, data);
                            },
                            close(targetSocket) {
                                ServerManager.closePeer(targetSocket);
                            },
                            error(targetSocket, error) {
                                console.error(`[server:${targetSocket.data.connectionId}] target error`, error);
                                ServerManager.closePeer(targetSocket);
                            }
                        }
                    }).catch((error: unknown) => {
                        console.error(`[server:${connectionId}] failed to connect to target`, error);

                        try {
                            clientSocket.end();
                        } catch {
                            // Ignore close errors during shutdown race conditions.
                        }
                    });
                },
                data(clientSocket, data) {
                    ServerManager.forwardOrQueue(clientSocket, data);
                },
                close(clientSocket) {
                    ServerManager.closePeer(clientSocket);
                },
                error(clientSocket, error) {
                    console.error(`[server:${clientSocket.data.connectionId}] client error`, error);
                    ServerManager.closePeer(clientSocket);
                }
            }
        });

        console.log(
            `Server tunnel listening on ${SERVER_TUNNEL_CONFIG.listenHost}:${SERVER_TUNNEL_CONFIG.listenPort}`
        );
        console.log(
            `Forwarding traffic to target ${SERVER_TUNNEL_CONFIG.targetHost}:${SERVER_TUNNEL_CONFIG.targetPort}`
        );
        console.log(`Max concurrent connections supported: unbounded (subject to system limits).`);

        void listener;
    }
}