/**
 * Deno Deploy VLESS (精简稳定版)
 * 专为 Serverless 环境优化，剔除了文件系统和子进程操作
 */

// --- 1. 全局配置 ---
const PORT = 8000;
// 从环境变量获取 UUID，如果没有则使用默认值 (建议在后台设置 UUID 变量)
const UUID = Deno.env.get("UUID") || "a2056d0d-c98e-4aeb-9aab-37f64edd5710";
const PROXY_IP = Deno.env.get("PROXYIP") || ""; // 想要转发的优选IP (可选)
const SUB_PATH = "sub"; // 订阅路径

console.log(`Deno VLESS Server Running...`);
console.log(`UUID: ${UUID}`);

// --- 2. 核心逻辑函数 (先定义，防止报错) ---

/**
 * 解析 VLESS 协议头部
 */
function parseVlessHeader(chunk, userId) {
    if (chunk.byteLength < 24) return { hasError: true, msg: "Data too short" };
    const version = chunk[0];
    // 校验 UUID (这里为了容错，暂时不做强校验，需要的可以加上)
    
    const optLen = chunk[17];
    const cmd = chunk[18 + optLen]; // 1=TCP, 2=UDP
    
    if (cmd !== 1) {
        return { hasError: true, msg: `Unsupported CMD: ${cmd} (Only TCP)` };
    }

    const portIdx = 19 + optLen;
    const port = (chunk[portIdx] << 8) | chunk[portIdx + 1];
    
    let addrIdx = portIdx + 2;
    const addrType = chunk[addrIdx];
    let hostname = "";
    let rawIndex = 0;

    if (addrType === 1) { // IPv4
        hostname = chunk.slice(addrIdx + 1, addrIdx + 5).join(".");
        rawIndex = addrIdx + 5;
    } else if (addrType === 2) { // Domain
        const len = chunk[addrIdx + 1];
        hostname = new TextDecoder().decode(chunk.slice(addrIdx + 2, addrIdx + 2 + len));
        rawIndex = addrIdx + 2 + len;
    } else if (addrType === 3) { // IPv6
        // Deno Deploy 对 IPv6 支持有限，且代码处理复杂，暂不处理
        // 大部分情况是 IPv4 或 Domain
        return { hasError: true, msg: "IPv6 not supported in this lite version" };
    } else {
        return { hasError: true, msg: `Unknown address type: ${addrType}` };
    }

    return { hasError: false, port, hostname, rawIndex, version };
}

/**
 * 将远程 Socket 数据转发回 WebSocket
 */
async function pipeRemoteToWs(remote, ws) {
    const buffer = new Uint8Array(32 * 1024);
    try {
        while (true) {
            const n = await remote.read(buffer);
            if (n === null) break; // 连接关闭
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(buffer.subarray(0, n));
            } else {
                break;
            }
        }
    } catch (e) {
        // console.error("Pipe Error:", e);
    } finally {
        try { remote.close(); } catch (_) {}
        try { ws.close(); } catch (_) {}
    }
}

/**
 * 处理 WebSocket 连接
 */
async function handleVlessConnection(ws) {
    let isHeaderParsed = false;
    let remoteConnection = null;

    ws.onopen = () => { console.log("[WS] Connected"); };

    ws.onmessage = async (event) => {
        const chunk = new Uint8Array(event.data);

        // 1. 如果已经建立了连接，直接转发数据
        if (remoteConnection) {
            try {
                await remoteConnection.write(chunk);
            } catch (e) {
                console.error("Remote Write Error:", e);
                ws.close();
            }
            return;
        }

        // 2. 第一次收到数据，解析 VLESS 头部
        if (!isHeaderParsed) {
            const res = parseVlessHeader(chunk, UUID);
            if (res.hasError) {
                console.error(`[Header Error] ${res.msg}`);
                ws.close();
                return;
            }

            isHeaderParsed = true;
            // 如果设置了 PROXYIP 环境变量，则强制转发到该 IP
            const targetHost = PROXY_IP || res.hostname;
            const targetPort = res.port;

            console.log(`[Connecting] ${res.hostname}:${res.port} -> ${targetHost}`);

            // 限制：Deno Deploy 免费版通常只能连接 80/443 端口
            try {
                remoteConnection = await Deno.connect({
                    hostname: targetHost,
                    port: targetPort,
                });

                // VLESS 响应：成功建立连接
                ws.send(new Uint8Array([res.version, 0]));

                // 将头部携带的多余数据发给远程
                if (chunk.slice(res.rawIndex).length > 0) {
                    await remoteConnection.write(chunk.slice(res.rawIndex));
                }

                // 开始将远程数据转发回 WS
                pipeRemoteToWs(remoteConnection, ws);

            } catch (e) {
                console.error(`[Connect Failed] ${targetHost}:${targetPort} - ${e.message}`);
                ws.close();
            }
        }
    };

    ws.onclose = () => {
        console.log("[WS] Closed");
        if (remoteConnection) {
            try { remoteConnection.close(); } catch (_) {}
        }
    };
    
    ws.onerror = (e) => {
        console.error("[WS] Error:", e);
        if (remoteConnection) {
            try { remoteConnection.close(); } catch (_) {}
        }
    };
}

// --- 3. 启动 Web 服务 ---
Deno.serve({ port: PORT }, (req) => {
    const upgrade = req.headers.get("upgrade") || "";
    const url = new URL(req.url);

    // 情况 A: WebSocket 连接 (VLESS 代理)
    if (upgrade.toLowerCase() === "websocket") {
        try {
            const { socket, response } = Deno.upgradeWebSocket(req);
            handleVlessConnection(socket);
            return response;
        } catch (e) {
            console.error("WS Upgrade Failed:", e);
            return new Response("Websocket Upgrade Failed", { status: 500 });
        }
    }

    // 情况 B: 获取订阅链接
    if (url.pathname === `/${SUB_PATH}`) {
        const host = req.headers.get("host") || "deno-deploy";
        // 生成 V2RayN 格式的订阅链接
        // 格式: vless://UUID@HOST:443?security=tls&type=ws&host=HOST&path=/#Name
        const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=%2F#Deno-${host.split('.')[0]}`;
        
        return new Response(btoa(vlessLink), {
            headers: { "Content-Type": "text/plain; charset=utf-8" }
        });
    }

    // 情况 C: 默认首页
    return new Response(`Deno VLESS Server is Running.\nUUID: ${UUID}`, { 
        status: 200,
        headers: { "Content-Type": "text/plain" }
    });
});
