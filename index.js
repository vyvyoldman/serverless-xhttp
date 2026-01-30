/**
 * Deno Version of serverless-xhttp + Nezha
 * * 启动命令 (VPS/本地):
 * deno run --allow-net --allow-read --allow-write --allow-run --allow-env --unstable main.ts
 * * 环境变量 (Environment Variables):
 * - UUID: 你的 UUID
 * - NEZHA_SERVER: 哪吒面板地址 (例如: nz.abc.com:5555)
 * - NEZHA_KEY: 哪吒密钥
 * - PORT: 端口 (默认 8000)
 */

import { parse } from "https://deno.land/std@0.208.0/flags/mod.ts";
import { exists } from "https://deno.land/std@0.208.0/fs/exists.ts";

// --- 配置 ---
const FLAGS = parse(Deno.args);
const PORT = Number(Deno.env.get("PORT") || Deno.env.get("SERVER_PORT") || FLAGS.port || 8000);
const UUID = Deno.env.get("UUID") || "a2056d0d-c98e-4aeb-9aab-37f64edd5710";
const NEZHA_SERVER = Deno.env.get("NEZHA_SERVER") || "";
const NEZHA_PORT = Deno.env.get("NEZHA_PORT") || ""; // 哪吒V0端口, V1不需要
const NEZHA_KEY = Deno.env.get("NEZHA_KEY") || "";
const SUB_PATH = Deno.env.get("SUB_PATH") || "sub";
const NAME = Deno.env.get("NAME") || "Deno-Node";
const PROXY_IP = Deno.env.get("PROXYIP") || ""; // 可选: 转发到的目标IP

// 检查是否运行在 Deno Deploy 环境 (无法运行子进程)
const IS_DEPLOY = Deno.env.get("DENO_DEPLOYMENT_ID") !== undefined;

console.log(`Server starting on port ${PORT}`);
console.log(`UUID: ${UUID}`);
console.log(`Environment: ${IS_DEPLOY ? "Deno Deploy (Serverless)" : "VPS/Local (Full)"}`);

// --- Nezha Agent 逻辑 (仅限 VPS/本地) ---
async function runNezha() {
  if (IS_DEPLOY) {
    console.log("Running on Deno Deploy: Nezha Agent skipped (binary execution not allowed).");
    return;
  }

  if (!NEZHA_SERVER || !NEZHA_KEY) {
    console.log("Nezha config missing, skipping agent.");
    return;
  }

  const arch = Deno.build.arch;
  const os = Deno.build.os;
  
  if (os !== "linux") {
    console.log("Nezha agent currently only supports Linux via this script.");
    return;
  }

  const fileName = "npm"; // 伪装文件名
  
  // 1. 确定下载地址
  let downloadUrl = "";
  const domain = arch === "aarch64" ? "arm64.ssss.nyc.mn" : "amd64.ssss.nyc.mn";
  
  if (NEZHA_PORT) {
     // V0 Agent
     downloadUrl = `https://${domain}/agent`;
  } else {
     // V1 Agent
     downloadUrl = `https://${domain}/v1`;
  }

  // 2. 下载文件
  try {
    if (!await exists(fileName)) {
      console.log(`Downloading Nezha Agent from ${downloadUrl}...`);
      const resp = await fetch(downloadUrl);
      if (!resp.ok) throw new Error(`Download failed: ${resp.statusText}`);
      const data = await resp.arrayBuffer();
      await Deno.writeFile(fileName, new Uint8Array(data), { mode: 0o755 });
      console.log("Nezha Agent downloaded.");
    }
  } catch (e) {
    console.error("Failed to download Nezha:", e);
    return;
  }

  // 3. 生成配置或构建命令
  let cmdArgs: string[] = [];
  
  if (NEZHA_PORT) {
    // V0 Agent Logic
    const tls = ["443", "8443", "2096", "2087", "2083", "2053"].includes(NEZHA_PORT) ? "--tls" : "";
    cmdArgs = ["-s", `${NEZHA_SERVER}:${NEZHA_PORT}`, "-p", NEZHA_KEY];
    if (tls) cmdArgs.push("--tls");
  } else {
    // V1 Agent Logic
    // 生成 config.yaml
    const port = NEZHA_SERVER.includes(":") ? NEZHA_SERVER.split(":")[1] : "80";
    const isTls = ["443", "8443", "2096", "2087", "2083", "2053"].includes(port);
    
    const configYaml = `
client_secret: ${NEZHA_KEY}
server: ${NEZHA_SERVER}
tls: ${isTls}
skip_connection_count: true
skip_procs_count: true
uuid: ${UUID}
`;
    await Deno.writeTextFile("config.yaml", configYaml);
    cmdArgs = ["-c", "config.yaml"];
  }

  // 4. 运行
  console.log("Starting Nezha Agent...");
  try {
    const command = new Deno.Command(`./${fileName}`, {
      args: cmdArgs,
      stdout: "null",
      stderr: "null",
      stdin: "null",
    });
    command.spawn(); // 后台运行
    console.log("Nezha Agent is running.");
  } catch (e) {
    console.error("Failed to start Nezha:", e);
  }
}

// --- 辅助功能 ---
async function getMyIP() {
    try {
        const rsp = await fetch("https://api.ip.sb/geoip");
        const data = await rsp.json();
        return { ip: data.ip, country: data.country_code, isp: data.isp };
    } catch {
        return { ip: "127.0.0.1", country: "XX", isp: "Unknown" };
    }
}

// --- HTTP 服务 & VLESS WebSocket ---
Deno.serve({ port: PORT }, async (req, info) => {
  const url = new URL(req.url);
  const upgrade = req.headers.get("upgrade") || "";

  // 1. 处理 WebSocket (VLESS 核心)
  if (upgrade.toLowerCase() === "websocket") {
    // 可选：在这里验证 UUID 路径，例如 /UUID
    // if (!url.pathname.includes(UUID)) return new Response("Auth fail", { status: 403 });

    const { socket, response } = Deno.upgradeWebSocket(req);
    handleVlessConnection(socket);
    return response;
  }

  // 2. 处理订阅 /sub
  if (url.pathname === `/${SUB_PATH}`) {
    const host = req.headers.get("host") || "localhost";
    const { ip, country, isp } = await getMyIP();
    const finalName = NAME ? `${NAME}-${country}` : `Deno-${country}`;
    
    // 生成 VLESS WS TLS 链接
    // 注意：如果是 HTTP 运行（没套 CDN/TLS），security=none。如果套了 CF，security=tls
    const isTls = host.includes("deno.dev") || PORT === 443;
    const vlessLink = `vless://${UUID}@${host}:443?encryption=none&security=tls&type=ws&host=${host}&path=%2F#${encodeURIComponent(finalName)}`;
    
    // 生成 Base64
    const b64 = btoa(vlessLink);
    return new Response(b64, { headers: { "Content-Type": "text/plain" } });
  }

  // 3. 默认页面
  return new Response("Deno VLESS Server Running", { status: 200 });
});


// --- VLESS 协议处理逻辑 ---
async function handleVlessConnection(ws: WebSocket) {
    let isHeaderParsed = false;
    let remoteConnection: Deno.Conn | null = null;

    ws.onopen = () => { /* console.log("WS Open"); */ };
    
    ws.onmessage = async (event) => {
        let chunk: Uint8Array;
        if (event.data instanceof ArrayBuffer) {
            chunk = new Uint8Array(event.data);
        } else {
            return; // 暂不支持文本帧
        }

        // 如果已连接远程，直接转发
        if (remoteConnection) {
            try {
                await remoteConnection.write(chunk);
            } catch {
                ws.close();
            }
            return;
        }

        // 解析 VLESS 头部
        if (!isHeaderParsed) {
            try {
                const { hasError, port, hostname, rawIndex, version } = parseVlessHeader(chunk, UUID);
                if (hasError) {
                    console.error("VLESS Header parse failed");
                    ws.close();
                    return;
                }
                
                isHeaderParsed = true;
                const finalHost = PROXY_IP ? PROXY_IP : hostname; // 支持手动指定转发IP
                
                // 建立 TCP 连接
                remoteConnection = await Deno.connect({
                    hostname: finalHost,
                    port: port,
                });

                // 发送 VLESS 响应头部 (Version + 0)
                ws.send(new Uint8Array([version[0], 0]));

                // 写入剩余数据
                const rawData = chunk.slice(rawIndex);
                if (rawData.length > 0) {
                    await remoteConnection.write(rawData);
                }

                // 将远程数据管道回 WS
                pipeRemoteToWs(remoteConnection, ws);

            } catch (e) {
                console.error("Connect failed:", e);
                ws.close();
            }
        }
    };

    ws.onclose = () => {
        if (remoteConnection) {
            try { remoteConnection.close(); } catch (_) {}
        }
    };
}

async function pipeRemoteToWs(conn: Deno.Conn, ws: WebSocket) {
    try {
        for await (const chunk of conn.readable) {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(chunk);
            } else {
                break;
            }
        }
    } catch (_) {
        // error
    } finally {
        try { conn.close(); } catch (_) {}
        if (ws.readyState === WebSocket.OPEN) ws.close();
    }
}

// VLESS 头部解析工具
function parseVlessHeader(chunk: Uint8Array, userId: string) {
    if (chunk.byteLength < 24) return { hasError: true };
    const version = chunk.slice(0, 1);
    const uuidBytes = chunk.slice(1, 17);
    const requestUuid = bytesToUuid(uuidBytes);
    
    // UUID 校验
    if (requestUuid !== userId) {
        // return { hasError: true }; // 严格模式可开启
    }

    const optLen = chunk[17];
    const cmd = chunk[18 + optLen]; // 1=TCP, 2=UDP
    const portIdx = 19 + optLen;
    const port = (chunk[portIdx] << 8) | chunk[portIdx + 1];
    
    let addrIdx = portIdx + 2;
    const addrType = chunk[addrIdx];
    let hostname = "";
    let addrEnd = 0;

    if (addrType === 1) { // IPv4
        hostname = chunk.slice(addrIdx + 1, addrIdx + 5).join(".");
        addrEnd = addrIdx + 5;
    } else if (addrType === 2) { // Domain
        const len = chunk[addrIdx + 1];
        hostname = new TextDecoder().decode(chunk.slice(addrIdx + 2, addrIdx + 2 + len));
        addrEnd = addrIdx + 2 + len;
    } else if (addrType === 3) { // IPv6
        // 简化处理
        addrEnd = addrIdx + 17;
        hostname = "ipv6-not-supported-yet"; 
    }

    return {
        hasError: false,
        port,
        hostname,
        rawIndex: addrEnd,
        version
    };
}

function bytesToUuid(bytes: Uint8Array) {
    const hex = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

// 启动 Nezha
runNezha();
