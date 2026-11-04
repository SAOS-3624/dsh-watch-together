"""daemon.py — 常驻的 edge-tts 合成器 + 常驻播放管道。

## 为什么要有它（实测，2026-11-04，Win11 / i9-12900HX）

老路子是「每句起一个 `edge-tts.exe`，合成到临时 mp3，再起一个 `ffplay`」。实测端到端
**2.4~3.0 秒**，拆开是：

| 段 | 耗时 |
|---|---|
| pip 的 exe shim 拉起 python | ~600ms |
| python 解释器冷启动 | ~600ms |
| `import edge_tts` | ~700ms |
| WebSocket 建连（DNS+TCP+TLS+token） | 620~760ms |
| 首块合成 | 200~300ms |
| 剩余音频块 | 30~130ms |
| ffplay 启动 + demuxer 探测 | 380~410ms |

每一段都是**每句付一次**。所以优化不是一个点，是三条：

1. **常驻进程**：python 和 edge_tts 只加载一次 —— 省掉上面第 1~3 段（~1.9s）。
2. **长连接复用**：一条 WebSocket 上连发多个 SSML 请求（Azure 协议本来就支持）。
   实测连续 20 句首块 **min 182 / avg 200 / max 235ms**，没有退化。
   服务端在 `turn.end` 之后约 **30 秒**关连接（30s 还活着、35s 已死；发 ping 保不住），
   所以空闲超过 `IDLE_TTL` 就主动断，下次用时重建。
3. **常驻 ffplay**：一个 ffplay 从 stdin 连续吃 mp3 帧。实测两段音频拼着写进去能
   连着播、播完不退出（`M-A` 时间码一路涨到 3.0s）。每句起进程 = 380~410ms 首声。

落到的效果（同一台机器）：
- 已预取（音频在内存）→ 写管道即出声，**~0ms**
- 未预取、连接热 → 首块 **200~300ms**
- 连接刚断（空闲 >30s）→ 重建 620~760ms + 首块

## 协议

stdin（每行一个 JSON）：

    {"op":"warm"}                                   起 ffplay + 建连（不阻塞）
    {"op":"prefetch","id":N,"text":"…"}             只合成，存内存，可撤回
    {"op":"say","id":N,"text":"…"}                  合成并播放（缓存命中则直接播）
    {"op":"forget","id":N}                          丢掉这句的缓存
    {"op":"stop"}

stdout（每行一个 JSON，全部是**状态**，不含音频）：

    {"ev":"ready"}                                  预热完成
    {"ev":"first","id":N,"ms":230}                  首块已进播放管道 = 马上出声
    {"ev":"done","id":N,"ms":380}
    {"ev":"skip","id":N,"reason":"…"}               缓存被丢掉（forget）
    {"ev":"error","id":N,"reason":"…"}

`first` 的语义和语音总线里的 `spoken` 一致：**音频已经交给播放设备**，展示层收到
就可以把字摆出来。报早了我们只是把字提前一点点，报晚了就是老毛病（字等人声）。
"""

import asyncio
import json
import os
import queue
import ssl
import subprocess
import sys
import threading
import time
import uuid

import aiohttp

from edge_tts.communicate import date_to_string, mkssml
from edge_tts.constants import SEC_MS_GEC_VERSION, WSS_HEADERS, WSS_URL
from edge_tts.data_classes import TTSConfig
from edge_tts.drm import DRM

# edge_tts 用的是同一份 SSL 配置；照抄，否则某些机器握手失败。
_SSL = ssl.create_default_context()
_SSL.set_ciphers("ECDHE+AESGCM:ECDHE+CHACHA20:DHE+AESGCM:DHE+CHACHA20")
try:
    _SSL.set_alpn_protocols(["http/1.1"])
except NotImplementedError:
    pass
_SSL.options |= ssl.OP_LEGACY_SERVER_CONNECT

#: 服务端实测 30s 关连接，留 5s 余量：宁可早断一次（重建 700ms），
#: 也不要拿着一条已经死的连接去发请求（那是直接丢一句话）。
IDLE_TTL = 25.0

#: 缓存的音频上限。一句中文 30 字约 30~60KB，80 句 ≈ 4MB，够一整段还有余。
MAX_CACHED = 80

EMIT_LOCK = threading.Lock()


def emit(**kw):
    """写一行 JSON 到 stdout。多线程调用，必须串行（否则两行会缠在一起）。"""
    with EMIT_LOCK:
        sys.stdout.write(json.dumps(kw, ensure_ascii=False) + "\n")
        sys.stdout.flush()


def log(msg):
    sys.stderr.write(f"[tts] {msg}\n")
    sys.stderr.flush()


def config():
    home = os.environ.get("DSH_HOME") or os.path.join(
        os.environ.get("USERPROFILE") or os.environ.get("HOME") or os.path.expanduser("~"), ".dsh")
    try:
        with open(os.path.join(home, "tts.json"), encoding="utf-8") as f:
            return json.load(f) or {}
    except Exception:
        return {}


def escape(text):
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


# --------------------------------------------------------------- 播放


class Player:
    """常驻 ffplay。一个进程连续吃 mp3 帧，句与句之间不重启。

    写管道用独立线程：ffplay 的管道缓冲区满了会阻塞，而调用方（事件循环）不能停在
    那里 —— 它还得收下一句的请求。阻塞的部分扔给线程，主循环永远不卡。
    """

    def __init__(self, volume=100, loglevel="quiet"):
        self.volume = volume
        self.loglevel = loglevel
        self._q = queue.Queue()
        self._proc = None
        self._thread = None
        self._broken = False
        self._fails = 0

    def start(self):
        if self._thread is None:
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()
        return not self._broken

    def play(self, data):
        """把一段 mp3 交给播放队列。返回 False = 播放器起不来。"""
        if self._broken or not data:
            return False
        # 线程意外退出（写入线程里抛了没兜住）时自己拉起来，别让后面整场哑掉
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._loop, daemon=True)
            self._thread.start()
        self._q.put(bytes(data))
        return True

    def prime(self):
        """喂一小段静音，把 ffplay 的 demuxer 探测（~200ms）提前花掉。

        探测是按"流里第一块数据"触发的，所以光起进程没用 —— 必须真喂点字节。
        这段是 0.3 秒静音，用户听不见，但它让真正的第一句话省下 200ms。
        """
        try:
            with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "warm.mp3"), "rb") as f:
                self.play(f.read())
        except Exception:
            pass  # 没有这个文件就退回"第一句多等 200ms"，不影响功能

    def stop(self):
        self._q.put(None)
        proc = self._proc
        self._proc = None
        if proc is not None:
            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                proc.kill()
            except Exception:
                pass

    def interrupt(self):
        """截断"正在念的这一句"：倒空待喂队列 + 杀掉 ffplay。

        为什么需要：常驻 ffplay 是按顺序吃 mp3 帧的，一条管道进去就得念完。
        串行链只保证"不重叠"，挡不住"越排越长" —— 模型连说三句，第三句要等到
        十几秒后才开口，那时候画面早换了。

        下一帧数据进来时 `_loop` 会发现 `_proc is None` 自动 `_spawn` 一个新的，
        所以**下一句是立刻开始念**，代价只是新进程要做一次 demuxer 探测（~200ms）。
        """
        while True:
            try:
                self._q.get_nowait()
            except queue.Empty:
                break
            except Exception:
                break
        proc = self._proc
        self._proc = None
        if proc is not None:
            try:
                proc.kill()
            except Exception:
                pass

    def _spawn(self):
        args = ["ffplay", "-nodisp", "-loglevel", self.loglevel, "-volume", str(self.volume), "-"]
        extra = {"creationflags": 0x08000000} if os.name == "nt" else {}  # CREATE_NO_WINDOW
        # 默认 quiet + 丢掉 stderr；调试时 `DSH_TTS_FFPLAY_LOG=info` 把时间码放出来
        # （看得到 `M-A` 一路涨就说明真的在播，而不是管道里堆着）。
        err = subprocess.DEVNULL if self.loglevel == "quiet" else None
        # bufsize=0：mp3 帧要立刻流出去，带缓冲会让首声晚一个 8KB
        proc = subprocess.Popen(
            args, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL,
            stderr=err, bufsize=0, **extra,
        )
        self._proc = proc
        return proc

    def _loop(self):
        while True:
            data = self._q.get()
            if data is None:
                break
            ok = False
            for _ in range(2):  # 一次重试：ffplay 偶发启动失败（设备被独占）时拉起来
                try:
                    proc = self._proc
                    if proc is None or proc.poll() is not None:
                        proc = self._spawn()
                    assert proc.stdin is not None
                    proc.stdin.write(data)
                    proc.stdin.flush()
                    ok = True
                    break
                except Exception as e:  # noqa: BLE001
                    log(f"ffplay 写入失败：{e}")
                    self._proc = None
            if ok:
                self._fails = 0
                continue
            # 连续三次都起不来才认定播放通道死了。一次失败（切音频设备、独占冲突）
            # 不该让后面整场都没声音 —— 下一句还会再试。
            self._fails += 1
            if self._fails >= 3:
                self._broken = True
                log("ffplay 连续起不来，播放通道关闭")
                break


# --------------------------------------------------------------- 合成


class EdgeLink:
    """一条 WebSocket，连发多句。同一时刻只能有一个请求在飞（aiohttp 不允许并发 receive）。"""

    def __init__(self, voice, rate):
        self.conf = TTSConfig(voice=voice, rate=rate, volume="+0%",
                              pitch="+0Hz", boundary="SentenceBoundary")
        self.ws = None
        self.session = None
        self.last_used = 0.0
        self.builds = 0

    async def ensure(self):
        fresh = self.ws is not None and not self.ws.closed \
            and (time.monotonic() - self.last_used) < IDLE_TTL
        if fresh:
            return True
        await self.close()
        url = (f"{WSS_URL}&ConnectionId={uuid.uuid4().hex}"
               f"&Sec-MS-GEC={DRM.generate_sec_ms_gec()}&Sec-MS-GEC-Version={SEC_MS_GEC_VERSION}")
        self.session = aiohttp.ClientSession(trust_env=True)
        self.ws = await self.session.ws_connect(url, compress=15, headers=WSS_HEADERS, ssl=_SSL)
        await self.ws.send_str(
            f"X-Timestamp:{date_to_string()}\r\n"
            "Content-Type:application/json; charset=utf-8\r\n"
            "Path:speech.config\r\n\r\n"
            '{"context":{"synthesis":{"audio":{"metadataoptions":{'
            '"sentenceBoundaryEnabled":"true","wordBoundaryEnabled":"false"},'
            '"outputFormat":"audio-24khz-48kbitrate-mono-mp3"}}}}\r\n'
        )
        self.builds += 1
        # **建连成功就要打时间戳**：不打的话下一次 `ensure()` 会看到
        # `monotonic() - 0` 是个巨大的数，判定"已过期"再重建一遍 —— 预热白做，
        # 第一句反而多付 700ms（实测踩过）。
        self.last_used = time.monotonic()
        log(f"连接已建立（第 {self.builds} 次）")
        return True

    async def close(self):
        if self.ws is not None:
            try:
                await self.ws.close()
            except Exception:
                pass
            self.ws = None
        if self.session is not None:
            try:
                await self.session.close()
            except Exception:
                pass
            self.session = None

    async def synth(self, text, on_chunk):
        """合成一句。`on_chunk(bytes)` 每块调一次 —— 想边收边播就把块直接写进管道。

        返回总字节数。连接中途断掉会重建并**整句重来**（半句音频已经写出去了，
        拼接会错位；这一句宁可慢一次也要完整）。
        """
        for attempt in (0, 1):
            try:
                await self.ensure()
                total = await self._run_turn(text, on_chunk if attempt == 0 else None)
                if total is None and attempt == 0:
                    continue  # 收到一半断了：重来一次，这次先收全再给
                self.last_used = time.monotonic()
                return total
            except Exception as e:  # noqa: BLE001
                if attempt == 1:
                    raise
                log(f"合成失败，重建连接重试：{e}")
                await self.close()
        return 0

    async def _run_turn(self, text, on_chunk):
        rid = uuid.uuid4().hex
        ssml = mkssml(self.conf, escape(text))
        payload = (f"X-RequestId:{rid}\r\n"
                   "Content-Type:application/ssml+xml\r\n"
                   f"X-Timestamp:{date_to_string()}Z\r\n"
                   "Path:ssml\r\n\r\n"
                   f"{ssml}")
        await self.ws.send_str(payload)
        total = 0
        while True:
            msg = await asyncio.wait_for(self.ws.receive(), timeout=20)
            if msg.type == aiohttp.WSMsgType.BINARY:
                data = msg.data
                hlen = int.from_bytes(data[:2], "big")
                body = data[2 + hlen:]
                if body:
                    total += len(body)
                    if on_chunk is not None:
                        on_chunk(body)
            elif msg.type == aiohttp.WSMsgType.TEXT:
                if "Path:turn.end" in msg.data:
                    return total
            else:
                # 连接没了。已经写出半句时不能重来（音频会错位），只能当这句失败。
                raise ConnectionError(f"连接关闭（type={msg.type}，已收 {total}B）")


# --------------------------------------------------------------- 主流程


class Daemon:
    def __init__(self):
        cfg = config()
        self.cfg = cfg
        self.voice = cfg.get("voice") or "zh-CN-YunxiNeural"
        rate = float(cfg.get("rate") or 0)
        self.rate = f"{'+' if rate >= 0 else ''}{round(rate * 3)}%"
        try:
            volume = int(os.environ.get("DSH_TTS_VOLUME") or 100)
        except ValueError:
            volume = 100
        self.player = Player(volume=volume, loglevel=os.environ.get("DSH_TTS_FFPLAY_LOG") or "quiet")
        self.edge = EdgeLink(self.voice, self.rate)
        self.cache = {}          # text -> bytes
        self.order = []          # 缓存淘汰顺序
        self.jobs = asyncio.PriorityQueue()
        self.seq = 0
        self.said = {}           # id -> text（say 用，便于 forget 精确删）
        self.warm_task = None

    def cached(self, text):
        return self.cache.get(text)

    def remember(self, text, data):
        if text in self.cache:
            return
        self.cache[text] = data
        self.order.append(text)
        while len(self.order) > MAX_CACHED:
            old = self.order.pop(0)
            self.cache.pop(old, None)

    async def warm(self):
        if self.warm_task is None:
            self.warm_task = asyncio.create_task(self._warm())
        return self.warm_task

    async def _warm(self):
        self.player.start()
        self.player.prime()
        try:
            await self.edge.ensure()
        except Exception as e:  # noqa: BLE001
            log(f"预热建连失败（第一次会再试）：{e}")
        emit(ev="ready")

    async def handle(self, req):
        op = req.get("op")
        if op == "warm":
            await self.warm()
            return
        if op == "say":
            await self.jobs.put((0, self.seq, req))
            self.seq += 1
            return
        if op == "prefetch":
            if not req.get("text"):
                return
            await self.jobs.put((1, self.seq, req))
            self.seq += 1
            return
        if op == "forget":
            text = req.get("text") or self.said.get(req.get("id"))
            if text:
                self.cache.pop(text, None)
                try:
                    self.order.remove(text)
                except ValueError:
                    pass
            emit(ev="skip", id=req.get("id"))
            return
        if op == "interrupt":
            # 新的一句要开口了：把正在念的截断，别让它排队排到画面之外
            self.player.interrupt()
            emit(ev="interrupted")
            return
        if op == "stop":
            raise SystemExit(0)

    async def run_job(self, req):
        rid = req.get("id")
        text = str(req.get("text") or "").strip()
        if not text:
            emit(ev="error", id=rid, reason="empty-text")
            return
        hit = self.cached(text)
        if hit is not None and req.get("op") == "say":
            # 预取已经合成好了：音频直接进管道，首声就是设备延迟（~50ms）。
            t0 = time.monotonic()
            if not self.player.play(hit):
                emit(ev="error", id=rid, reason="player-unavailable")
                return
            emit(ev="first", id=rid, ms=round((time.monotonic() - t0) * 1000))
            emit(ev="done", id=rid, ms=round((time.monotonic() - t0) * 1000))
            return

        if req.get("op") == "prefetch":
            if hit is not None:
                emit(ev="done", id=rid, ms=0)
                return
            buf = bytearray()
            t0 = time.monotonic()
            try:
                await self.edge.synth(text, buf.extend)
            except Exception as e:  # noqa: BLE001
                emit(ev="error", id=rid, reason=str(e)[:160])
                return
            self.remember(text, bytes(buf))
            emit(ev="done", id=rid, ms=round((time.monotonic() - t0) * 1000), bytes=len(buf))
            return

        # say 且没缓存：边收边播 —— 首块进管道就算出声，不等整句。
        t0 = time.monotonic()
        first = [None]
        buf = bytearray()

        def sink(chunk):
            buf.extend(chunk)
            if first[0] is None:
                if self.player.play(chunk):
                    first[0] = (time.monotonic() - t0) * 1000
                    emit(ev="first", id=rid, ms=round(first[0]))
            else:
                self.player.play(chunk)

        try:
            await self.edge.synth(text, sink)
        except Exception as e:  # noqa: BLE001
            emit(ev="error", id=rid, reason=str(e)[:160])
            return
        self.remember(text, bytes(buf))
        emit(ev="done", id=rid, ms=round((time.monotonic() - t0) * 1000))

    async def worker(self):
        while True:
            _, _, req = await self.jobs.get()
            try:
                await self.run_job(req)
            except Exception as e:  # noqa: BLE001
                log(f"任务异常：{e}")
            finally:
                self.jobs.task_done()

    async def main(self):
        emit(ev="boot", voice=self.voice, rate=self.rate)
        asyncio.create_task(self.worker())
        loop = asyncio.get_running_loop()
        # 前台保持一根暖连接：进程起来就把建连（~700ms）花掉，别等第一句话。
        asyncio.create_task(self.warm())
        try:
            while True:
                line = await loop.run_in_executor(None, sys.stdin.buffer.readline)
                if not line:
                    break
                try:
                    req = json.loads(line.decode("utf-8", "replace"))
                except Exception:
                    continue
                await self.handle(req)
        finally:
            self.player.stop()
            await self.edge.close()


if __name__ == "__main__":
    try:
        asyncio.run(Daemon().main())
    except (KeyboardInterrupt, SystemExit):
        pass
