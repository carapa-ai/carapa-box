import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('internal WebSocket routing is opt-in, authenticated, direct and path-bounded', async () => {
  // Exercise Node's production upgrade transport, with an unreachable Squid.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'service-websocket-'));
  const script = `
    import http from 'node:http'; import net from 'node:net'; import fs from 'node:fs';
    import { once } from 'node:events'; import assert from 'node:assert/strict';
    import { startApiRelay } from ${JSON.stringify(new URL('./api-relay/api-relay.mjs', import.meta.url).href)};
    const root = ${JSON.stringify(root)}; let identity = 'approved-agent';
    const sockets = new Set(); let seen = [];
    const track = s => { sockets.add(s); s.on('close',()=>sockets.delete(s)); s.on('error',()=>{}); return s; };
    const upstream = http.createServer();
    upstream.on('upgrade',(req,socket,head)=>{
      track(socket); seen.push(req.headers);
      assert.equal(req.url,'/api/web-browser/sessions/example/cdp');
      socket.write('HTTP/1.1 101 Switching Protocols\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\nearly-frame');
      socket.on('data',data=>socket.end(data)); if(head.length) socket.end(head);
    });
    upstream.listen(0,'127.0.0.1'); await once(upstream,'listening');
    const service = {host:'127.0.0.1',port:upstream.address().port,protocol:'http',auth:'apikey',envKey:'SERVICE_TOKEN',websocketPaths:['/api/web-browser/sessions/']};
    const config = {match:['approved-agent'],isolation:'strict',services:{'board-api':service}};
    fs.writeFileSync(root+'/client.json',JSON.stringify(config));
    const relay = startApiRelay({port:0,host:'127.0.0.1',clientsDir:root,hostnameResolver:()=>identity,
      env:{HTTP_PROXY:'http://127.0.0.1:1',SNI_BRIDGE_PORT:'0',RELAY_REQUIRE_KNOWN_CLIENTS:'1',SERVICE_TOKEN:'upstream-credential'}});
    if(!relay.server.listening) await once(relay.server,'listening');
    async function request(target) {
      const s=track(net.connect(relay.server.address().port,'127.0.0.1'));
      s.write('GET /board-api'+target+' HTTP/1.1\\r\\nHost: relay\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\nAuthorization: Bearer must-strip\\r\\nX-Carapa-Browser-Token: lease-credential\\r\\n\\r\\nclient-frame');
      let result=''; for await(const chunk of s) result+=chunk; return result;
    }
    const deadline=setTimeout(()=>{for(const s of sockets)s.destroy();},5000);
    try {
      const result=await request('/api/web-browser/sessions/example/cdp');
      assert.match(result,/^HTTP\\/1.1 101/); assert.match(result,/early-frame/); assert.match(result,/client-frame/);
      assert.equal(seen[0].authorization,'Bearer upstream-credential'); assert.equal(seen[0]['x-carapa-browser-token'],'lease-credential');
      assert.match(await request('/api/browser/ws'),/^HTTP\\/1.1 403/);
      assert.match(await request('/api/web-browser/sessions/example/cdp?token=bad'),/^HTTP\\/1.1 403/);
      identity='unknown'; assert.match(await request('/api/web-browser/sessions/example/cdp'),/^HTTP\\/1.1 403/);
      identity='approved-agent'; delete service.websocketPaths; fs.writeFileSync(root+'/client.json',JSON.stringify(config)); relay.reload();
      assert.match(await request('/api/web-browser/sessions/example/cdp'),/^HTTP\\/1.1 403/);
      assert.equal(seen.length,1);
    } finally { clearTimeout(deadline); for(const s of sockets)s.destroy(); relay.close(); upstream.close(); }
  `;
  try {
    const child = Bun.spawn(['node', '--input-type=module', '-e', script], {
      env: { PATH: process.env.PATH }, stdout: 'pipe', stderr: 'pipe',
    });
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    if (await child.exited !== 0) throw new Error(stderr + stdout);
    expect(await child.exited).toBe(0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);
