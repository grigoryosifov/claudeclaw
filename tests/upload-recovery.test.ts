import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isUploadError, continuationPrompt, IMAGE_PLACEHOLDER } from "../src/bodyGuard";

test("upload-error detection matches the transport failures, not ordinary errors", () => {
  expect(isUploadError("Error (exit 1): API Error: Connection dropped (ECONNRESET)")).toBe(true);
  expect(isUploadError("LibreSSL SSL_read: sslv3 alert bad record mac")).toBe(true);
  expect(isUploadError("socket hang up")).toBe(true);
  expect(isUploadError("Claude session timed out after 3600s")).toBe(false);
  expect(isUploadError("No conversation found with session ID: x")).toBe(false);
  expect(isUploadError("Error: file not found")).toBe(false);
});

test("the continuation prompt carries the original message and the no-repeat rule", () => {
  const p = continuationPrompt("[Telegram from joe]\nMessage: draft the vortex email");
  expect(p).toContain("draft the vortex email");
  expect(p).toContain("do not repeat anything that already took effect");
});

/**
 * Drives the real runner through run() in a child bun process, with a fake `claude` on PATH:
 * call 1 starts a session and writes a transcript holding 8 screenshots; call 2 (a resumed turn)
 * fails with the ECONNRESET text Claude Code prints; the runner must shrink the transcript and
 * run call 3 with the continuation prompt, whose reply becomes the turn's result.
 */
test("a resumed run that dies on ECONNRESET is shrunk and continued once", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "upload-recovery-")));
  const home = join(root, "home");
  const ccHome = join(root, "cchome");
  const ws = join(root, "ws");
  const bin = join(root, "bin");
  for (const d of [home, ccHome, ws, bin]) mkdirSync(d, { recursive: true });
  const calls = join(root, "calls.log");
  const sid = "11111111-2222-4333-8444-555555555555";
  const projDir = join(home, ".claude", "projects", ws.replace(/[/\\.]/g, "-"));
  const fake = `#!/bin/bash
prompt=""; prev=""
for a in "$@"; do [ "$prev" = "-p" ] && prompt="$a"; prev="$a"; done
n=$(( $(cat "${root}/count" 2>/dev/null || echo 0) + 1 )); echo $n > "${root}/count"
printf '%s\\t%s\\n' "$n" "$(printf '%s' "$prompt" | head -c 40)" >> "${calls}"
if [ "$prompt" = "/compact" ]; then echo compacted; exit 0; fi
echo '{"type":"system","subtype":"init","session_id":"${sid}"}'
if [ $n -eq 1 ]; then
  mkdir -p "${projDir}"
  python3 - <<'PY'
import json
img = {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "A" * 200000}}
rows = [{"type": "user", "uuid": "u0", "message": {"role": "user", "content": "hello"}}]
for i in range(8):
    rows.append({"type": "user", "uuid": f"t{i}", "message": {"role": "user", "content": [{"type": "tool_result", "tool_use_id": f"x{i}", "content": [img]}]}})
    rows.append({"type": "assistant", "uuid": f"a{i}", "message": {"role": "assistant", "content": [{"type": "text", "text": f"step {i}"}]}})
with open("${projDir}/${sid}.jsonl", "w") as fh:
    fh.write("\\n".join(json.dumps(r) for r in rows) + "\\n")
PY
  echo '{"type":"result","subtype":"success","result":"FIRST OK","session_id":"${sid}"}'; exit 0
fi
if [ $n -eq 2 ]; then
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"API Error: Connection dropped (ECONNRESET)","session_id":"${sid}"}'; exit 1
fi
echo '{"type":"result","subtype":"success","result":"RECOVERED","session_id":"${sid}"}'; exit 0
`;
  writeFileSync(join(ccHome, "settings.json"), JSON.stringify({ model: "claude-opus-5-5", security: { level: "unrestricted" } }));
  writeFileSync(join(bin, "claude"), fake);
  chmodSync(join(bin, "claude"), 0o755);
  const script = `
import { loadSettings } from ${JSON.stringify(join(import.meta.dir, "..", "src", "config"))};
import { run } from ${JSON.stringify(join(import.meta.dir, "..", "src", "runner"))};
await loadSettings();
const a = await run("telegram", "hello");
const b = await run("telegram", "draft the vortex email");
process.stdout.write("\\nRESULT " + JSON.stringify({ a: a.stdout, b: b.stdout, bExit: b.exitCode }) + "\\n");
`;
  writeFileSync(join(ws, "_run.ts"), script);
  const proc = Bun.spawn(["bun", "run", join(ws, "_run.ts")], {
    cwd: ws,
    env: { ...process.env, HOME: home, CLAUDECLAW_HOME: ccHome, PATH: `${bin}:${process.env.PATH}` },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  const line = out.split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) throw new Error("no RESULT line\n" + out.slice(-2000) + "\n" + err.slice(-2000));
  const r = JSON.parse(line.slice(7));
  expect(r.a).toContain("FIRST OK");
  expect(r.b).toContain("RECOVERED");
  expect(r.bExit).toBe(0);
  const log = readFileSync(calls, "utf8").trim().split("\n");
  expect(log.length).toBe(3); // no compact: 8 screenshots stripped brought it far under 4 MB
  expect(log[2]).toContain("[claudeclaw] Your previous");
  const transcript = readFileSync(join(projDir, `${sid}.jsonl`), "utf8");
  expect(transcript.split(IMAGE_PLACEHOLDER).length - 1).toBe(5); // 8 screenshots, the last 6 rows keep theirs (3 images)
  expect(readdirSync(projDir).some((f) => f.includes(".bak-"))).toBe(true);
  expect(out + err).toContain("Upload recovery: succeeded");
}, 60_000);
