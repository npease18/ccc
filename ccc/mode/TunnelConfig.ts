export type ServerTunnelConfig = {
    listenHost: string;
    listenPort: number;
    targetHost: string;
    targetPort: number;
};

export type ClientTunnelConfig = {
    localBindHost: string;
    localBindPort: number;
    serverHost: string;
    serverPort: number;
};

export const SERVER_TUNNEL_CONFIG: ServerTunnelConfig = {
    listenHost: "0.0.0.0",
    listenPort: 9000,
    targetHost: "127.0.0.1",
    targetPort: 8080
};

export const CLIENT_TUNNEL_CONFIG: ClientTunnelConfig = {
    localBindHost: "127.0.0.1",
    localBindPort: 7000,
    serverHost: "127.0.0.1",
    serverPort: 9000
};
