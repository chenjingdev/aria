// aria — GUI 웹서버: 정적 페이지 + SSE 실시간 반영 + HTTP API(/api/rpc)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { state, subscribe, runOp, libraryNames, keyInfo } from "./core.js";
import { playInfo } from "./player.js";
import { renderRange, wavBuffer, toneDefaults } from "./synth.js";
import { totalBars, beatsPerBar, tempoSegments, beatToSec } from "./song.js";
import { PRESETS, DRUM_KITS, DRUM_PIECES, TEMPLATES, SF_PRESETS, SF_DRUM_KITS } from "./presets.js";
import { sf2Available } from "./sf2.js";
import {
  PREFERRED_PORT,
  PORT_ATTEMPTS,
  createRuntimeIdentity,
  publishRuntime
} from "./runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(__dirname, "..", "public", "index.html");

const sseClients = new Set();

function sseSend(res, ev) {
  res.write(`data: ${JSON.stringify(ev)}\n\n`);
}

export function startWeb() {
  const identity = createRuntimeIdentity();

  const bridgeAuth = req => {
    const value = req.headers.authorization;
    if (typeof value !== "string" || !value.startsWith("Bearer ")) return { supplied: Boolean(value), valid: false };
    const supplied = Buffer.from(value.slice(7));
    const expected = Buffer.from(identity.bridgeToken);
    return {
      supplied: true,
      valid: supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected)
    };
  };

  const unsubscribe = subscribe(ev => {
    for (const res of sseClients) { try { sseSend(res, ev); } catch { /* 끊긴 클라이언트 */ } }
  });

  // 브라우저 교차 출처 요청 차단(CSRF) — 로컬 도구(curl/node fetch)는 이 헤더가 없어 통과한다
  // Sec-Fetch-Site는 브라우저가 강제로 붙이는 위조 불가 헤더라 우선 신뢰한다
  // (same-origin이면 터널 도메인 경유든 로컬이든 GUI 자신의 요청이다)
  const crossOrigin = (req) => {
    const site = req.headers["sec-fetch-site"];
    if (site) return site !== "same-origin" && site !== "none";
    const origin = req.headers.origin;
    if (origin) {
      const port = state.guiUrl ? new URL(state.guiUrl).port : null;
      if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) return true;
    }
    return false;
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    try {
      if (req.method === "GET" && url.pathname === "/api/health") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({
          ok: true,
          app: "aria",
          schema: 1,
          pid: identity.pid,
          instanceId: identity.instanceId,
          baseUrl: state.guiUrl,
          startedAt: identity.startedAt
        }));
      } else if (req.method === "GET" && url.pathname === "/") {
        const page = fs.readFileSync(INDEX);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page);
      } else if (req.method === "GET" && url.pathname === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive"
        });
        sseClients.add(res);
        sseSend(res, { type: "state", song: state.song, playing: playInfo(), songs: libraryNames(), ...keyInfo() });
        for (const entry of state.log.slice(-50)) sseSend(res, { type: "log", entry });
        const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* noop */ } }, 25000);
        req.on("close", () => { clearInterval(ping); sseClients.delete(res); });
      } else if (req.method === "GET" && url.pathname === "/api/meta") {
        const sfOk = sf2Available();
        const json = {
          presets: {
            ...Object.fromEntries(Object.entries(PRESETS).map(([id, p]) => [id, { name: p.name, desc: p.desc }])),
            ...(sfOk ? Object.fromEntries(Object.entries(SF_PRESETS).map(([id, p]) => [id, { name: `${p.name} ⬡`, desc: p.desc }])) : {})
          },
          drumKits: {
            ...Object.fromEntries(Object.entries(DRUM_KITS).map(([id, k]) => [id, { name: k.name, desc: k.desc }])),
            ...(sfOk ? Object.fromEntries(Object.entries(SF_DRUM_KITS).map(([id, k]) => [id, { name: `${k.name} ⬡`, desc: k.desc }])) : {})
          },
          drumPieces: Object.keys(DRUM_PIECES),
          templates: Object.fromEntries(Object.entries(TEMPLATES).map(([id, t]) => [id, { name: t.name, desc: t.desc }])),
          // 프리셋별 음색 기본값 — GUI의 음색 판이 "기본" 눈금을 정직한 위치에 찍는 데 쓴다
          tone: Object.fromEntries([...Object.keys(PRESETS), ...Object.keys(DRUM_KITS),
            ...(sfOk ? [...Object.keys(SF_PRESETS), ...Object.keys(SF_DRUM_KITS)] : [])]
            .map(id => [id, toneDefaults(id)]))
        };
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(json));
      } else if (req.method === "GET" && url.pathname === "/api/stem") {
        // "즉시 믹스"용 트랙 스템 — 트랙 하나를 볼륨·음소거 없이 렌더해 WAV로 돌려준다.
        // 브라우저가 캐시한 뒤 Web Audio 게인으로 실시간 믹스한다 (렌더는 여기 한 번뿐)
        if (crossOrigin(req)) { res.writeHead(403); res.end("교차 출처 요청은 허용되지 않습니다"); return; }
        const song = state.song;
        if (!song) { res.writeHead(400); res.end("곡이 없습니다"); return; }
        const name = url.searchParams.get("track") ?? "";
        const track = song.tracks.find(t => t.name === name);
        if (!track) { res.writeHead(404); res.end(`트랙 "${name}"이 없습니다`); return; }
        const total = totalBars(song);
        const from = Math.min(Math.max(1, parseInt(url.searchParams.get("from") ?? "1", 10) || 1), total);
        const to = Math.min(Math.max(from, parseInt(url.searchParams.get("to") ?? "", 10) || total), total);
        const bpb = beatsPerBar(song), segs = tempoSegments(song);
        const sec = beatToSec(segs, to * bpb) - beatToSec(segs, (from - 1) * bpb);
        if (sec > 240) {
          res.writeHead(413);
          res.end(`구간이 너무 깁니다(${Math.round(sec)}초) — 즉시 믹스는 한 번에 240초까지입니다. 구간(from–to)을 지정해 주세요`);
          return;
        }
        const { left, right, sr } = renderRange(song, from, to, { stem: name });
        res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
        res.end(wavBuffer(left, right, sr));
      } else if (req.method === "POST" && url.pathname === "/api/rpc") {
        if (crossOrigin(req)) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "교차 출처 요청은 허용되지 않습니다" }));
          return;
        }
        const auth = bridgeAuth(req);
        if (auth.supplied && !auth.valid) {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "MCP 브리지 인증 정보가 올바르지 않습니다" }));
          return;
        }
        const parts = [];
        let size = 0, overflow = false;
        req.on("data", c => {
          size += c.length;
          if (size > 5_000_000) {
            overflow = true;
            res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "요청이 너무 큽니다(5MB 제한)" }));
            req.destroy();
            return;
          }
          parts.push(c);
        });
        req.on("end", () => {
          if (overflow) return;
          try {
            const { tool, args } = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
            const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : (args ?? {});
            // HTTP 경유(GUI·터널)의 내보내기는 기본 폴더로만 — 임의 경로 쓰기 차단 (MCP 경로는 제한 없음)
            if (tool === "export" && !auth.valid) delete safeArgs.path;
            const result = runOp(tool, safeArgs, auth.valid ? "mcp" : "gui");
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, result }));
          } catch (e) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      } else {
        res.writeHead(404); res.end("not found");
      }
    } catch (e) {
      if (!res.headersSent) res.writeHead(500);
      res.end(e.message);
    }
  });

  return new Promise((resolve, reject) => {
    let port = PREFERRED_PORT, attempts = 0;
    const tryListen = () => {
      server.once("error", err => {
        if (err.code === "EADDRINUSE" && attempts++ < PORT_ATTEMPTS - 1) { port++; tryListen(); }
        else reject(err);
      });
      server.listen(port, "127.0.0.1", () => {
        state.guiUrl = `http://127.0.0.1:${port}`;
        server.once("close", unsubscribe);
        try {
          publishRuntime({ ...identity, baseUrl: state.guiUrl });
        } catch (error) {
          server.close();
          reject(error);
          return;
        }
        resolve({ server, port, url: state.guiUrl, instanceId: identity.instanceId });
      });
    };
    tryListen();
  });
}
