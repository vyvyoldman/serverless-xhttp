/**
 * Deno Version of serverless-xhttp + Nezha (Pure JS)
 * * 启动命令 (VPS/本地):
 * deno run --allow-net --allow-read --allow-write --allow-run --allow-env --unstable index.js
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
  let cmdArgs = [];
  
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


// --- VLESS 协议处理逻辑
