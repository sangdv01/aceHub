/**
 * aceHub Windows & Home Server Engine (Port 8000)
 * ----------------------------------------------------
 * - Native Windows & Cross-Platform Support (Zero-Dependency)
 * - Auto-detects AceStream dynamic port (%APPDATA%/ACEStream/engine/acestream.port)
 * - VIP Auth 0 Handshake (0 Ads, Commercial Nag Bypass)
 * - Rock-solid 0-Transcode MPEG-TS Stream Relay
 * - Live Sports Channel Directory & Web Dashboard
 */

const http = require('http');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PRODUCT_KEY = "n51LvQoTlJzNGaFxseRK-uvnvX-sD4Vm5Axwmc4UcoD-jruxmKsuJaH0eVgE";
const PROXY_PORT = parseInt(process.env.ACE_PROXY_PORT || "8000", 10);
const ACE_HTTP_PORT = 6878;

function getAceTelnetPort() {
    if (process.env.ACE_TELNET_PORT) {
        return parseInt(process.env.ACE_TELNET_PORT, 10);
    }
    const appData = process.env.APPDATA;
    if (appData) {
        const portFile = path.join(appData, 'ACEStream', 'engine', 'acestream.port');
        try {
            if (fs.existsSync(portFile)) {
                const content = fs.readFileSync(portFile, 'utf8').trim();
                const port = parseInt(content, 10);
                if (port > 0) return port;
            }
        } catch (e) {}
    }
    return 62062;
}

function computeReadyKey(reqKey, productKey = PRODUCT_KEY) {
    const sha1 = crypto.createHash('sha1').update(reqKey + productKey).digest('hex');
    const prefix = productKey.split('-')[0];
    return `${prefix}-${sha1}`;
}

// Background VIP Auth Maintainer
let isEngineVip = false;
let telnetSocket = null;

function maintainTelnetAuth() {
    const port = getAceTelnetPort();
    telnetSocket = net.createConnection({ host: '127.0.0.1', port }, () => {
        telnetSocket.write("HELLOBG version=4\r\n");
    });

    telnetSocket.setEncoding('utf8');

    telnetSocket.on('data', (data) => {
        const lines = data.split(/\r?\n/);
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;

            if (trimmed.startsWith("HELLOTS")) {
                const match = trimmed.match(/key=([^\s]+)/);
                if (match) {
                    const ready = computeReadyKey(match[1]);
                    telnetSocket.write(`READY key=${ready}\r\n`);
                }
            } else if (trimmed.startsWith("AUTH")) {
                isEngineVip = true;
                console.log(`[aceHub] VIP Auth 0 Confirmed: ${trimmed} (No Ads)`);
                telnetSocket.write("SETOPTIONS use_stop_notifications=1\r\n");
            }
        }
    });

    telnetSocket.on('error', (err) => {
        isEngineVip = false;
    });

    telnetSocket.on('close', () => {
        isEngineVip = false;
        setTimeout(maintainTelnetAuth, 5000); // Reconnect if closed
    });
}

maintainTelnetAuth();

// Stream State
let activeStreamInfo = null;
let activeClients = 0;
let graceTimer = null;
const startTime = Date.now();

function getLocalIp() {
    const os = require('os');
    const nets = os.networkInterfaces();
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal && !net.address.startsWith('169.254.')) {
                return net.address;
            }
        }
    }
    return "127.0.0.1";
}

function stopCurrentStream() {
    if (activeStreamInfo) {
        console.log(`[aceHub] Stopping stream for ${activeStreamInfo.id}...`);
        if (telnetSocket && isEngineVip) {
            try {
                telnetSocket.write("STOP\r\nSTOPDL\r\n");
            } catch (e) {}
        }
        activeStreamInfo = null;
    }
}

// Pipe stream with automatic HTTP 302 follow
function pipeStreamWithRedirects(targetUrl, clientRes, maxRedirects = 5) {
    if (maxRedirects <= 0) {
        clientRes.writeHead(502, { 'Content-Type': 'text/plain' });
        clientRes.end("Too many redirects from AceStream engine");
        return;
    }

    const req = http.get(targetUrl, { headers: { 'User-Agent': 'aceHub-Proxy/1.0' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const redirectUrl = res.headers.location.startsWith('http')
                ? res.headers.location
                : `http://127.0.0.1:${ACE_HTTP_PORT}${res.headers.location}`;
            res.resume(); // discard body
            pipeStreamWithRedirects(redirectUrl, clientRes, maxRedirects - 1);
            return;
        }

        // Send headers to video player
        clientRes.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
            'Connection': 'close',
            'Cache-Control': 'no-cache, no-store'
        });

        res.pipe(clientRes);

        res.on('error', (err) => {
            console.error(`[aceHub] Upstream read error: ${err.message}`);
            clientRes.end();
        });
    });

    req.on('error', (err) => {
        console.error(`[aceHub] Upstream request error: ${err.message}`);
        if (!clientRes.headersSent) {
            clientRes.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
            clientRes.end(`Lỗi kết nối AceStream Engine: ${err.message}`);
        }
    });

    clientRes.on('close', () => {
        req.destroy();
    });
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    const parsed = url.parse(req.url, true);
    const pathname = parsed.pathname;
    const query = parsed.query;

    if (req.method === 'HEAD') {
        res.writeHead(200, {
            'Content-Type': 'video/mp2t',
            'Access-Control-Allow-Origin': '*',
            'Connection': 'close'
        });
        res.end();
        return;
    }

    // Dashboard UI
    if (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard') {
        renderDashboard(res);
        return;
    }

    // Live Sports API
    if (pathname === '/channels' || pathname === '/api/channels') {
        try {
            const channelsRes = await fetch(`http://127.0.0.1:${ACE_HTTP_PORT}/search?page_size=200&page=0`);
            const json = await channelsRes.json();
            const results = json?.result?.results || [];
            const sports = [];
            for (const item of results) {
                for (const sub of (item.items || [])) {
                    if (sub.categories && (sub.categories.includes('sport') || sub.name.toLowerCase().includes('sport') || sub.name.toLowerCase().includes('laliga') || sub.name.toLowerCase().includes('football') || sub.name.toLowerCase().includes('arena') || sub.name.toLowerCase().includes('match') || sub.name.toLowerCase().includes('pol')) ) {
                        sports.push({
                            name: sub.name,
                            infohash: sub.infohash,
                            bitrate: sub.bitrate,
                            languages: sub.languages,
                            stream_url: `http://${getLocalIp()}:${PROXY_PORT}/live?id=${sub.infohash}`
                        });
                    }
                }
            }
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(sports, null, 2));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // Match Realtime Search API (Crawler tự động bắt đúng trận theo tên đội & EPG)
    if (pathname === '/api/match-search') {
        const home = (query.home || query.q || '').trim().toLowerCase();
        const away = (query.away || '').trim().toLowerCase();
        try {
            const queries = [];
            if (home) queries.push(fetch(`http://127.0.0.1:${ACE_HTTP_PORT}/search?query=${encodeURIComponent(home)}&page_size=50`).then(r => r.json()).catch(() => null));
            if (away) queries.push(fetch(`http://127.0.0.1:${ACE_HTTP_PORT}/search?query=${encodeURIComponent(away)}&page_size=50`).then(r => r.json()).catch(() => null));
            queries.push(fetch(`http://127.0.0.1:${ACE_HTTP_PORT}/search?query=football&page_size=100`).then(r => r.json()).catch(() => null));

            const responses = await Promise.all(queries);
            const matches = [];
            const seen = new Set();

            for (const resData of responses) {
                if (!resData?.result?.results) continue;
                for (const group of resData.result.results) {
                    const epgList = group.epg || [];
                    for (const item of (group.items || [])) {
                        if (seen.has(item.infohash)) continue;
                        const itemName = (item.name || '').toLowerCase();
                        let isMatch = false;
                        let matchType = 'Luồng trực tiếp';

                        // So khớp với EPG lịch phát sóng
                        for (const epg of epgList) {
                            const epgTitle = `${epg.name || ''} ${epg.description || ''}`.toLowerCase();
                            if ((home && epgTitle.includes(home)) || (away && epgTitle.includes(away))) {
                                isMatch = true;
                                matchType = `EPG: ${epg.name || 'Lịch phát sóng'}`;
                                break;
                            }
                        }

                        // So khớp với tiêu đề kênh
                        if (!isMatch && ((home && itemName.includes(home)) || (away && itemName.includes(away)))) {
                            isMatch = true;
                            matchType = 'Tên trận đấu';
                        }

                        if (isMatch) {
                            seen.add(item.infohash);
                            matches.push({
                                exact_match: true,
                                name: item.name,
                                infohash: item.infohash,
                                bitrate: item.bitrate,
                                languages: item.languages,
                                match_type: matchType
                            });
                        }
                    }
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify({ found: matches.length, matches }, null, 2));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
        }
        return;
    }

    // Status API
    if (pathname === '/stat' || pathname === '/status' || pathname === '/health') {
        let peers = 0;
        let speedKbps = 0;
        if (activeStreamInfo?.statUrl) {
            try {
                const sRes = await fetch(activeStreamInfo.statUrl);
                const sJson = await sRes.json();
                peers = sJson?.response?.peers || 0;
                speedKbps = sJson?.response?.speed_down || 0;
            } catch (e) {}
        }
        const data = {
            name: "aceHub Home Server Engine",
            version: "1.0.0",
            status: activeStreamInfo ? "ACTIVE" : "IDLE",
            vip_authenticated: isEngineVip,
            channel: activeStreamInfo?.id || null,
            channel_name: activeStreamInfo?.name || null,
            peers: peers,
            speed_kbps: speedKbps,
            speed_mbps: +( (speedKbps * 8) / 1024 ).toFixed(2),
            active_clients: activeClients,
            uptime_seconds: Math.floor((Date.now() - startTime) / 1000)
        };
        res.writeHead(200, {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Connection': 'close'
        });
        res.end(JSON.stringify(data, null, 2));
        return;
    }

    if (pathname === '/stop') {
        stopCurrentStream();
        res.writeHead(200, { 'Content-Type': 'application/json', 'Connection': 'close' });
        res.end(JSON.stringify({ success: true, message: "Stream stopped" }));
        return;
    }

    // Stream handler: /live?id=... or /ace/getstream?id=...
    let streamId = query.id || query.content_id || query.pid || query.infohash;
    if (!streamId) {
        if (pathname.startsWith('/content_id/')) streamId = pathname.split('/content_id/')[1].split('/')[0];
        else if (pathname.startsWith('/infohash/')) streamId = pathname.split('/infohash/')[1].split('/')[0];
        else if (pathname.startsWith('/pid/')) streamId = pathname.split('/pid/')[1].split('/')[0];
        else if (pathname.startsWith('/live/') || pathname.startsWith('/stream/')) streamId = pathname.split('/')[2];
    }

    if (!streamId) {
        res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end("Thiếu mã kênh (Ví dụ: /live?id=<CONTENT_ID_HOAC_INFOHASH>)");
        return;
    }

    const isInfohash = (streamId.length === 40 && /^[a-fA-F0-9]{40}$/.test(streamId));
    const param = isInfohash ? `infohash=${streamId}` : `id=${streamId}`;

    if (graceTimer) {
        clearTimeout(graceTimer);
        graceTimer = null;
    }

    // Channel switching: stop previous if changed
    if (activeStreamInfo && activeStreamInfo.id !== streamId) {
        console.log(`[aceHub] Switching channels: ${activeStreamInfo.id} -> ${streamId}`);
        stopCurrentStream();
    }

    activeClients++;
    console.log(`[aceHub] Client joined for stream ${streamId.slice(0, 12)}... Active: ${activeClients}`);

    // Call AceStream getstream format=json to retrieve playback_url and stat_url
    let playbackUrl = `http://127.0.0.1:${ACE_HTTP_PORT}/ace/getstream?${param}`;
    try {
        const metaRes = await fetch(`http://127.0.0.1:${ACE_HTTP_PORT}/ace/getstream?format=json&${param}`);
        const metaJson = await metaRes.json();
        if (metaJson?.response?.playback_url) {
            playbackUrl = metaJson.response.playback_url;
            activeStreamInfo = {
                id: streamId,
                playbackUrl: metaJson.response.playback_url,
                statUrl: metaJson.response.stat_url,
                commandUrl: metaJson.response.command_url
            };
        }
    } catch (e) {
        activeStreamInfo = { id: streamId, playbackUrl };
    }

    pipeStreamWithRedirects(playbackUrl, res);

    res.on('close', () => {
        activeClients = Math.max(0, activeClients - 1);
        console.log(`[aceHub] Client left. Active remaining: ${activeClients}`);
        if (activeClients === 0) {
            console.log("[aceHub] Starting 8s cooldown before freeing swarm...");
            graceTimer = setTimeout(() => {
                if (activeClients === 0) {
                    stopCurrentStream();
                }
            }, 8000);
        }
    });
});

async function renderDashboard(res) {
    const localIp = getLocalIp();
    
    // Fetch active sports channels
    let sportsHtml = '';
    try {
        const channelsRes = await fetch(`http://127.0.0.1:${ACE_HTTP_PORT}/search?page_size=100&page=0`);
        const json = await channelsRes.json();
        const results = json?.result?.results || [];
        const sports = [];
        for (const item of results) {
            for (const sub of (item.items || [])) {
                if (sub.categories && (sub.categories.includes('sport') || sub.name.toLowerCase().includes('sport') || sub.name.toLowerCase().includes('laliga') || sub.name.toLowerCase().includes('arena') || sub.name.toLowerCase().includes('match') || sub.name.toLowerCase().includes('pol'))) {
                    sports.push(sub);
                }
            }
        }
        
        sportsHtml = sports.slice(0, 15).map(s => `
            <div style="background: rgba(255,255,255,0.03); border: 1px solid #1e293b; padding: 12px 16px; border-radius: 8px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <span style="font-weight: 600; color: #f8fafc;">${s.name}</span>
                    <span style="font-size: 12px; color: #94a3b8; margin-left: 8px;">[${(s.languages || []).join(',')}]</span>
                </div>
                <a href="/live?id=${s.infohash}" target="_blank" style="background: #0284c7; color: white; text-decoration: none; padding: 6px 12px; border-radius: 6px; font-size: 13px; font-weight: 500;">Phát Trực Tiếp</a>
            </div>
        `).join('');
    } catch (e) {
        sportsHtml = '<p style="color:#ef4444;">Không tải được danh sách kênh: ' + e.message + '</p>';
    }

    const html = `<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>aceHub | Trạm Phát Thể Thao Home Server</title>
    <style>
        :root {
            --bg: #090d16;
            --card: #121929;
            --border: #1e293b;
            --primary: #38bdf8;
            --accent: #22c55e;
            --text: #f8fafc;
            --muted: #94a3b8;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        body { background: var(--bg); color: var(--text); padding: 32px 16px; min-height: 100vh; }
        .container { max-width: 860px; margin: 0 auto; }
        .header { text-align: center; margin-bottom: 28px; }
        .logo { font-size: 32px; font-weight: 800; letter-spacing: -0.5px; background: linear-gradient(135deg, var(--primary), var(--accent)); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .subtitle { color: var(--muted); margin-top: 8px; font-size: 15px; }
        .card { background: var(--card); border: 1px solid var(--border); border-radius: 16px; padding: 24px; margin-bottom: 24px; box-shadow: 0 10px 25px rgba(0,0,0,0.3); }
        .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 16px; margin-top: 16px; }
        .stat-box { background: rgba(255,255,255,0.02); border: 1px solid rgba(255,255,255,0.05); padding: 16px; border-radius: 12px; text-align: center; }
        .stat-value { font-size: 24px; font-weight: 700; color: var(--primary); margin-top: 4px; }
        .stat-label { font-size: 13px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.5px; }
        .badge { display: inline-block; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
        .badge-live { background: rgba(34, 197, 94, 0.15); color: var(--accent); border: 1px solid rgba(34, 197, 94, 0.3); }
        .badge-idle { background: rgba(148, 163, 184, 0.15); color: var(--muted); border: 1px solid rgba(148, 163, 184, 0.3); }
        .code-box { background: #050811; border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; font-family: monospace; font-size: 14px; color: #38bdf8; word-break: break-all; margin-top: 8px; }
        h2 { font-size: 18px; margin-bottom: 12px; font-weight: 600; display: flex; align-items: center; justify-content: space-between; }
        p { color: var(--muted); font-size: 14px; line-height: 1.6; margin-bottom: 8px; }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div class="logo">aceHub</div>
            <div class="subtitle">Home Server Headless Engine (Windows Edition)</div>
        </div>

        <div class="card">
            <h2>
                <span>Trạng thái Trạm phát</span>
                <span class="badge ${activeStreamInfo ? 'badge-live' : 'badge-idle'}">${activeStreamInfo ? '● ĐANG PHÁT LUỒNG' : '○ CHỜ KẾT NỐI'}</span>
            </h2>
            <div class="stats-grid">
                <div class="stat-box">
                    <div class="stat-label">Chế độ VIP Auth</div>
                    <div class="stat-value" style="color: #22c55e;">0 ADS</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Thiết bị đang xem</div>
                    <div class="stat-value">${activeClients}</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Độ phân giải</div>
                    <div class="stat-value">1080P/4K</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Độ trễ LAN</div>
                    <div class="stat-value">&lt; 50ms</div>
                </div>
            </div>
            ${activeStreamInfo ? `<div style="margin-top:16px;"><div class="stat-label">Kênh đang phát:</div><div class="code-box">${activeStreamInfo.id}</div></div>` : ''}
        </div>

        <div class="card">
            <h2>Danh sách Kênh Thể Thao Đang Phát (Trực tiếp từ AceStream Swarm)</h2>
            <p style="margin-bottom: 16px;">Bấm nút <strong>Phát Trực Tiếp</strong> để mở luồng hoặc sao chép link dán vào VLC/Smart TV:</p>
            ${sportsHtml}
        </div>

        <div class="card">
            <h2>Cú pháp phát luồng trên TV (VLC / Kodi / Apple TV / Smart TV)</h2>
            <p>Mở ứng dụng trên TV cùng mạng Wi-Fi và dán:</p>
            <div class="code-box">http://${localIp}:8000/live?id=&lt;MA_KENH&gt;</div>
        </div>
    </div>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
}

server.listen(PROXY_PORT, '0.0.0.0', () => {
    const localIp = getLocalIp();
    console.log(`==========================================================`);
    console.log(` aceHub Server is RUNNING on port ${PROXY_PORT}!`);
    console.log(` • Dashboard & Kênh Thể Thao: http://localhost:${PROXY_PORT}/`);
    console.log(` • Stream URL Mạng LAN: http://${localIp}:${PROXY_PORT}/live?id=<ID>`);
    console.log(`==========================================================`);
});
