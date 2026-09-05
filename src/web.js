// aria — GUI 웹서버: 정적 페이지 + SSE 실시간 반영 + HTTP API(/api/rpc)
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { state, subscribe, runOp, libraryNames, keyInfo } from "./core.js";
import { playInfo } from "./player.js";
import { renderRange } from "./sampler-renderer.js";
import { wavBuffer, toneDefaults } from "./renderer.js";
import { totalBars, beatsPerBar, tempoSegments, beatToSec } from "./song.js";
import { DRUM_PIECES, TEMPLATES, SF_PRESETS, SF_DRUM_KITS } from "./presets.js";
import { samplerAssetStatus, samplerAssetName, samplerEngineLabel } from "./sampler-assets.js";
import { listPacks, startPackInstall } from "./packs.js";
import { chooseExportDirectory as nativeChooseExportDirectory } from "./export-dialog.js";
import { soundSetupStatus, chooseSoundFile as nativeChooseSoundFile, importBasicSoundfont, basicSoundPreview } from "./sound-setup.js";
import { setupInfo, completeOnboarding } from "./setup.js";
import { APP_VERSION } from "./version.js";
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

export function startWeb({ chooseExportDirectory = nativeChooseExportDirectory, chooseSoundFile = nativeChooseSoundFile } = {}) {
  const identity = createRuntimeIdentity();
  let exportDialogPending = false;
  let soundDialogPending = false;
  const ai = { lastSeenAt: null };

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
          version: APP_VERSION,
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
      } else if (req.method === "GET" && url.pathname === "/api/setup") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(setupInfo(ai)));
      } else if (req.method === "POST" && url.pathname === "/api/setup/complete") {
        if (crossOrigin(req)) { res.writeHead(403); res.end("교차 출처 요청은 허용되지 않습니다"); return; }
        const onboarding = completeOnboarding();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: true, onboarding }));
      } else if (req.method === "GET" && url.pathname === "/api/sound-setup") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify(soundSetupStatus()));
      } else if (req.method === "POST" && ["/api/sound-setup/import", "/api/sound-setup/preview", "/api/packs/import"].includes(url.pathname)) {
        if (crossOrigin(req)) { res.writeHead(403); res.end("교차 출처 요청은 허용되지 않습니다"); return; }
        const id = url.searchParams.get("id");
        if (url.pathname === "/api/packs/import" && !listPacks().some(pack => pack.id === id))
          throw new Error("등록되지 않은 음원 팩입니다");
        if (url.pathname === "/api/sound-setup/preview") {
          const wav = basicSoundPreview();
          res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store" });
          res.end(wav);
          return;
        }
        if (soundDialogPending) throw new Error("이미 음원 파일을 선택하고 있습니다");
        if (url.pathname === "/api/sound-setup/import" && soundSetupStatus().basic.exists)
          throw new Error("기본 음원이 이미 있습니다. 기존 파일을 덮어쓰지 않습니다.");
        const controller = new AbortController();
        const abort = () => controller.abort();
        res.once("close", abort);
        soundDialogPending = true;
        void (async () => {
          try {
            const file = await chooseSoundFile({ signal: controller.signal, archive: url.pathname === "/api/packs/import" });
            if (res.destroyed) return;
            const result = file === null ? { ok: true, cancelled: true }
              : url.pathname === "/api/packs/import" ? { ok: true, pack: startPackInstall(id, { archive: file }) }
              : { ok: true, setup: importBasicSoundfont(file) };
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(result));
          } catch (error) {
            if (!res.destroyed) {
              res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
              res.end(JSON.stringify({ ok: false, error: error.message }));
            }
          } finally {
            soundDialogPending = false;
            res.off("close", abort);
          }
        })();
      } else if (req.method === "GET" && url.pathname === "/api/packs") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ packs: listPacks() }));
      } else if (req.method === "POST" && url.pathname === "/api/packs/install") {
        if (crossOrigin(req)) {
          res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: "교차 출처 요청은 허용되지 않습니다" }));
          return;
        }
        const parts = [];
        let size = 0, overflow = false;
        req.on("data", chunk => {
          size += chunk.length;
          if (size > 64 * 1024) {
            overflow = true;
            res.writeHead(413, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "요청이 너무 큽니다" }));
            req.destroy();
            return;
          }
          parts.push(chunk);
        });
        req.on("end", () => {
          if (overflow) return;
          try {
            const { id } = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
            const pack = startPackInstall(id);
            res.writeHead(202, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ ok: true, pack }));
          } catch (error) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: error.message }));
          }
        });
      } else if (req.method === "GET" && url.pathname === "/api/meta") {
        const metaPreset = (p, drum = false) => {
          const st = samplerAssetStatus(p, { shallow: true });
          return {
            name: `${p.name} ⬡${st.available ? "" : " · 미설치"}`,
            desc: p.desc,
            available: st.available,
            asset: samplerAssetName(p, st),
            // 기존 브라우저 탭 호환용 별칭. 새 UI는 asset을 사용한다.
            font: samplerAssetName(p, st),
            engine: samplerEngineLabel(p),
            issue: st.reason,
            family: p.family ?? null,
            familyDetail: p.familyDetail ?? p.family ?? null,
            source: p.source ?? null,
            sourceDetail: p.sourceDetail ?? p.source ?? null,
            articulation: p.articulation ?? null,
            articulations: p.articulations ?? null,
            defaultArticulation: p.defaultArticulation ?? null,
            category: p.category ?? null,
            sourceEntry: p.sourceEntry ?? null,
            recordedNote: p.recordedNote ?? null,
            recordedDynamic: p.recordedDynamic ?? null,
            aliasSearch: p.aliasSearch ?? null,
            kind: p.kind === "clip" ? "clip" : drum ? "percussion" : "instrument",
            assetKind: p.kind ?? (drum ? "drum-kit" : "instrument"),
            recommended: p.recommended === true,
            durationSec: Number.isFinite(p.durationSec) ? p.durationSec : null,
            pieces: drum ? Object.keys(p.pieces ?? DRUM_PIECES) : null,
            pieceLabels: p.pieceLabels ?? null
          };
        };
        const json = {
          presets: Object.fromEntries(Object.entries(SF_PRESETS).map(([id, p]) => [id, metaPreset(p, false)])),
          drumKits: Object.fromEntries(Object.entries(SF_DRUM_KITS).map(([id, p]) => [id, metaPreset(p, true)])),
          drumPieces: Object.keys(DRUM_PIECES),
          templates: Object.fromEntries(Object.entries(TEMPLATES).map(([id, t]) => [id, { name: t.name, desc: t.desc }])),
          // 프리셋별 음색 기본값 — GUI의 음색 판이 "기본" 눈금을 정직한 위치에 찍는 데 쓴다
          tone: Object.fromEntries([...Object.keys(SF_PRESETS), ...Object.keys(SF_DRUM_KITS)]
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
        req.on("end", async () => {
          if (overflow) return;
          try {
            const { tool, args } = JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
            const safeArgs = args && typeof args === "object" && !Array.isArray(args) ? { ...args } : (args ?? {});
            // GUI는 시스템 창에서 직접 고른 폴더만 사용한다. HTTP 입력의 임의 경로는 계속 차단한다.
            if (tool === "export" && !auth.valid) {
              delete safeArgs.path;
              delete safeArgs.directory;
              if (safeArgs.choose_folder === true) {
                if (exportDialogPending) throw new Error("이미 저장 폴더를 선택하고 있습니다");
                if (!state.song) throw new Error("곡이 없습니다");
                if (!state.song.tracks.some(t => t.notes.length)) throw new Error("내보낼 노트가 없습니다");
                if (!["midi", "wav", "mp3", "both"].includes(safeArgs.format ?? "both"))
                  throw new Error("format은 midi|wav|mp3|both 중에서 선택하세요");
                const songBefore = JSON.stringify(state.song);
                const controller = new AbortController();
                const abortDialog = () => controller.abort();
                res.once("close", abortDialog);
                exportDialogPending = true;
                try {
                  const directory = await chooseExportDirectory({ signal: controller.signal });
                  if (res.destroyed) return;
                  if (directory === null) {
                    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ ok: true, cancelled: true, result: "내보내기를 취소했습니다" }));
                    return;
                  }
                  if (JSON.stringify(state.song) !== songBefore)
                    throw new Error("폴더를 선택하는 동안 곡이 바뀌었습니다. 다시 내보내 주세요");
                  if (typeof directory !== "string" || !path.isAbsolute(directory))
                    throw new Error("선택한 저장 폴더 경로를 읽지 못했습니다");
                  safeArgs.directory = directory;
                } finally {
                  exportDialogPending = false;
                  res.off("close", abortDialog);
                }
              }
            }
            const result = runOp(tool, safeArgs, auth.valid ? "mcp" : "gui");
            if (auth.valid) ai.lastSeenAt = new Date().toISOString();
            res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: true, result }));
          } catch (e) {
            if (res.destroyed) return;
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: e.message }));
          }
        });
      } else {
        res.writeHead(404); res.end("not found");
      }
    } catch (e) {
      if (url.pathname.startsWith("/api/sound-setup/") || url.pathname.startsWith("/api/setup/") || url.pathname === "/api/packs/import") {
        if (!res.headersSent) res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      } else {
        if (!res.headersSent) res.writeHead(500);
        res.end(e.message);
      }
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
