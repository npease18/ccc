import { CLIENT_TUNNEL_CONFIG } from "../TunnelConfig.ts";

type TunnelSocketData = {
    peer?: Bun.Socket<TunnelSocketData>;
    pendingWrites: Uint8Array[];
    connectionId: number;
    role: "local" | "server";
};

export class ClientManager {
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
            hostname: CLIENT_TUNNEL_CONFIG.localBindHost,
            port: CLIENT_TUNNEL_CONFIG.localBindPort,
            socket: {
                open(localSocket) {
                    const connectionId = ClientManager.nextConnectionId++;
                    localSocket.data = {
                        pendingWrites: [],
                        connectionId,
                        role: "local"
                    };

                    void Bun.connect<TunnelSocketData>({
                        hostname: CLIENT_TUNNEL_CONFIG.serverHost,
                        port: CLIENT_TUNNEL_CONFIG.serverPort,
                        data: {
                            pendingWrites: [],
                            connectionId,
                            role: "server",
                            peer: localSocket
                        },
                        socket: {
                            open(serverSocket) {
                                localSocket.data.peer = serverSocket;
                                ClientManager.flushPending(localSocket);
                            },
                            data(serverSocket, data) {
                                ClientManager.forwardOrQueue(serverSocket, data);
                            },
                            close(serverSocket) {
                                ClientManager.closePeer(serverSocket);
                            },
                            error(serverSocket, error) {
                                console.error(`[client:${serverSocket.data.connectionId}] server error`, error);
                                ClientManager.closePeer(serverSocket);
                            }
                        }
                    }).catch((error: unknown) => {
                        console.error(`[client:${connectionId}] failed to connect to server`, error);

                        try {
                            localSocket.end();
                        } catch {
                            // Ignore close errors during shutdown race conditions.
                        }
                    });
                },
                data(localSocket, data) {
                    ClientManager.forwardOrQueue(localSocket, data);
                },
                close(localSocket) {
                    ClientManager.closePeer(localSocket);
                },
                error(localSocket, error) {
                    console.error(`[client:${localSocket.data.connectionId}] local error`, error);
                    ClientManager.closePeer(localSocket);
                }
            }
        });

        console.log(
            `Client tunnel listening on ${CLIENT_TUNNEL_CONFIG.localBindHost}:${CLIENT_TUNNEL_CONFIG.localBindPort}`
        );
        console.log(
            `Forwarding traffic to server ${CLIENT_TUNNEL_CONFIG.serverHost}:${CLIENT_TUNNEL_CONFIG.serverPort}`
        );

        void listener;
    }
}