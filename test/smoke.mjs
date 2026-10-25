// gmafx 冒烟测试：node test/smoke.mjs <BASE_URL>
// 检查订阅接口、Clash YAML、WebSocket 隧道、并发连接
const BASE = (process.argv[2] || process.env.BASE_URL || 'http://127.0.0.1:8787').replace(/\/$/, '');
const UUID = process.env.UUID || (await import('node:fs')).readFileSync(new URL('../_afxworker.js', import.meta.url), 'utf8').match(/const UUID = '([0-9a-f-]{36})'/)[1];
const CONCURRENCY = parseInt(process.env.CONCURRENCY || '30', 10);

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
};

// 1. 订阅接口
{
  const t = Date.now();
  const r = await fetch(BASE + '/');
  const body = await r.text();
  const lines = body.split('\n').filter(l => l.startsWith('vless://'));
  ok('订阅 / 返回 200', r.status === 200, `${Date.now() - t}ms`);
  ok('订阅含接入行', lines.length > 0, `${lines.length} 行`);
}
// 2. Clash YAML
{
  const r = await fetch(BASE + '/?format=clash');
  const body = await r.text();
  ok('Clash 返回 200', r.status === 200);
  ok('Clash 含 proxies/rules', body.includes('proxies:') && body.includes('rules:'));
}
// 3. 404
{
  const r = await fetch(BASE + '/nope');
  ok('未知路径 404', r.status === 404);
}

// 构造协议头：version0 + uuid16 + addons0 + cmd1(TCP) + port + atyp2(域名) + host
function header(host, port) {
  const u = Buffer.from(UUID.replace(/-/g, ''), 'hex');
  const h = Buffer.from(host);
  return Buffer.concat([Buffer.from([0]), u, Buffer.from([0, 1, port >> 8, port & 255, 2, h.length]), h]);
}

// 通过隧道请求 http://host/，返回 { ok, ms, bytes }
const TARGET = process.env.TARGET || 'www.baidu.com';   // 明文 HTTP 目标须为非 CF 站点（CF 站点直连被拦，明文又不能走 SNI 中继）
function tunnelGet(host = TARGET, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t = Date.now();
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/?ed=2048');
    ws.binaryType = 'arraybuffer';
    let buf = Buffer.alloc(0), done = false;
    const finish = (good) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} resolve({ ok: good, ms: Date.now() - t, bytes: buf.length, head: buf.subarray(2, 40).toString() }); };
    const timer = setTimeout(() => finish(false), timeoutMs);
    ws.onopen = () => {
      const req = Buffer.from(`GET / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      ws.send(Buffer.concat([header(host, 80), req]));
    };
    ws.onmessage = (ev) => {
      buf = Buffer.concat([buf, Buffer.from(typeof ev.data === 'string' ? Buffer.from(ev.data) : ev.data)]);
      if (buf.subarray(2).toString().includes('HTTP/1.')) finish(true);
    };
    ws.onerror = () => finish(false);
    ws.onclose = () => finish(buf.subarray(2).toString().includes('HTTP/1.'));
  });
}

// 4. 单条隧道
{
  const r = await tunnelGet();
  ok(`隧道 ${TARGET}:80（直连）`, r.ok, `${r.ms}ms ${r.bytes}B`);
}
// 5. 错误 UUID 应被拒（不返回 HTTP 数据）
{
  const saved = UUID;
  const bad = await new Promise((resolve) => {
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
    ws.binaryType = 'arraybuffer';
    let got = false;
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(!got); }, 3000);
    ws.onopen = () => {
      const h = header('example.com', 80); h.fill(0xaa, 1, 17);
      ws.send(Buffer.concat([h, Buffer.from('GET / HTTP/1.1\r\nHost: example.com\r\n\r\n')]));
    };
    ws.onmessage = () => { got = true; };
    ws.onclose = () => { clearTimeout(timer); resolve(!got); };
  });
  ok('错误 UUID 被拒', bad);
}

// 通过隧道做 TLS：目标是 CF 站点时会走中继路径（Worker CPU 主要消耗在这里）
async function tunnelTls(host = TLS_TARGET, timeoutMs = 15000) {
  const { Duplex } = await import('node:stream');
  const tls = await import('node:tls');
  return new Promise((resolve) => {
    const t = Date.now();
    const ws = new WebSocket(BASE.replace(/^http/, 'ws') + '/');
    ws.binaryType = 'arraybuffer';
    let first = true, skip = 2, done = false, opened = false, queue = [];
    const finish = (good, info = '') => { if (done) return; done = true; clearTimeout(timer); try { sock.destroy(); } catch {} try { ws.close(); } catch {} resolve({ ok: good, ms: Date.now() - t, info }); };
    const timer = setTimeout(() => finish(false, 'timeout'), timeoutMs);
    const send = (b) => { const out = first ? Buffer.concat([header(host, 443), b]) : b; first = false; ws.send(out); };
    const duplex = new Duplex({
      read() {},
      write(chunk, enc, cb) { if (opened) send(chunk); else queue.push(chunk); cb(); }
    });
    ws.onopen = () => { opened = true; if (queue.length) send(Buffer.concat(queue)); queue = []; };
    ws.onmessage = (ev) => {
      let b = Buffer.from(typeof ev.data === 'string' ? Buffer.from(ev.data) : ev.data);
      if (typeof ev.data === 'string') return finish(false, ev.data.slice(0, 80));
      if (skip) { const n = Math.min(skip, b.length); b = b.subarray(n); skip -= n; }
      if (b.length) duplex.push(b);
    };
    ws.onclose = () => { duplex.push(null); finish(false, 'ws closed'); };
    ws.onerror = () => finish(false, 'ws error');
    const sock = tls.connect({ socket: duplex, servername: host }, () => {
      sock.write(`HEAD / HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
    sock.on('data', (d) => { if (d.toString().startsWith('HTTP/1.')) finish(true, d.toString().split('\r\n')[0]); });
    sock.on('error', (e) => finish(false, e.message));
  });
}
const TLS_TARGET = process.env.TLS_TARGET || 'example.com';
{
  const r = await tunnelTls();
  ok(`TLS 隧道 ${TLS_TARGET}:443（CF 站点，走中继）`, r.ok, `${r.ms}ms ${r.info}`);
}

const TLS_CONCURRENCY = parseInt(process.env.TLS_CONCURRENCY || '10', 10);
{
  const rs = await Promise.all(Array.from({ length: TLS_CONCURRENCY }, () => tunnelTls()));
  const good = rs.filter(r => r.ok).length;
  ok(`并发 ${TLS_CONCURRENCY} 条 TLS 隧道（中继）`, good >= Math.ceil(TLS_CONCURRENCY * 0.8), `成功 ${good}/${TLS_CONCURRENCY}`);
}

// 6. 并发
{
  const t = Date.now();
  const rs = await Promise.all(Array.from({ length: CONCURRENCY }, () => tunnelGet()));
  const good = rs.filter(r => r.ok).length;
  const ms = rs.map(r => r.ms).sort((a, b) => a - b);
  ok(`并发 ${CONCURRENCY} 条隧道`, good >= Math.ceil(CONCURRENCY * 0.9),
     `成功 ${good}/${CONCURRENCY}，P50 ${ms[Math.floor(ms.length / 2)]}ms，P95 ${ms[Math.floor(ms.length * 0.95)]}ms，总 ${Date.now() - t}ms`);
}

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
