/**
 * chat-view.js — 聊天记录页（纯字符串，没有逻辑）。
 *
 *   CHAT_PAGE    完整版：消息列表 + 输入框
 *
 * 输入框的主入口是 `floating-window.js` 打开的 Python 悬浮窗；这个页面是**只读兜底**：
 * 想翻聊天记录、或悬浮窗起不来时手动打开 `http://127.0.0.1:9377/`。
 * 浏览器置顶小窗（`documentPictureInPicture`）那条老路已经删了 —— 它要先开一个标签页、
 * 关掉就没了，不如原生窗口。
 *
 * 单独成文件是因为这块 HTML **每次都要连着贴**（模板里一句 JS 都不能有语法错，否则页面全白，
 * 而错误只在浏览器控制台里，服务端「200 OK」一切正常）。它和 HTTP 路由混在一起时，
 * 改一个 padding 要翻服务代码，改路由又要跨过两百行 HTML。
 *
 * `__PORT__` 由 `chatServer.js` 在返回前替换成真实端口 —— 页面和 API 必须同源，
 * 写死 9377 的话换了端口输入框就发不出去。
 */

/** 完整版：消息列表 + 输入框 */
export const CHAT_PAGE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>陪看</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{background:#161616;color:#e0e0e0;font:16px/1.65 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:14px;max-width:680px}
#log{height:calc(100vh - 140px);overflow-y:auto;padding-bottom:8px}
.m{margin:8px 0;padding:9px 12px;border-radius:10px;white-space:pre-wrap;word-break:break-word}
.u{background:#26384a;margin-left:44px}
.a{background:#242424;margin-right:44px}
.l{background:#1c1a17;border-left:3px solid #7a5a2a;margin-right:44px}
.t{font-size:11px;opacity:.45;margin-bottom:3px}
form{display:flex;gap:8px;margin-top:10px}
input{flex:1;padding:11px;background:#202020;border:1px solid #3a3a3a;color:#eee;border-radius:9px;font-size:16px;outline:none}
input:focus{border-color:#4a7ab5}
#send{padding:11px 18px;background:#3a6ea5;color:#fff;border:0;border-radius:9px;font-size:15px}
</style></head><body>
<div id="log"></div>
<form id="f"><input id="i" placeholder="说点什么…（回车发送）" autocomplete="off">
<button type="submit" id="send">发送</button></form>
<script>
(function(){
  var BASE="http://127.0.0.1:__PORT__";
  var f=document.getElementById("f"), i=document.getElementById("i"), log=document.getElementById("log");
  function esc(s){return String(s).replace(/[<>&]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;"}[c];});}
  function fmt(s){s=Math.max(0,Number(s)||0);return ("0"+Math.floor(s/60)).slice(-2)+":"+("0"+(s%60).toFixed(1)).slice(-4);}
  function add(m){
    var kind=m.role==="user"?"u":(m.role==="line"?"l":"a");
    var who=m.role==="user"?"我":(m.role==="line"?"剧本"+(m.t!=null?" "+fmt(m.t):""):"陪看");
    var d=document.createElement("div");d.className="m "+kind;
    d.innerHTML="<div class=t>"+who+(m.say?" · 会念":'')+"</div>"+esc(m.text);
    log.appendChild(d);log.scrollTop=log.scrollHeight;}
  function send(){var v=i.value.trim();if(!v)return;i.value="";
    fetch(BASE+"/api/say",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({text:v})})
      .then(function(r){return r.json();})
      .then(function(j){if((!j||!j.ok)&&!i.value){i.value=v;i.focus();}})   // 没写进去就把话回填，不能丢字
      .catch(function(){if(!i.value){i.value=v;i.focus();}});}
  f.addEventListener("submit",function(e){e.preventDefault();send();});
  var n=0;
  function poll(){
    fetch(BASE+"/api/messages?since="+n+"&t="+Date.now()).then(function(r){return r.json();}).then(function(j){
      for(var k=0;k<j.msgs.length;k++)add(j.msgs[k]);
      n=j.total;setTimeout(poll,600);
    }).catch(function(){setTimeout(poll,1500);});
  }
  poll();i.focus();
})();
</script></body></html>`;

/** 把模板里的 `__PORT__` 换成真实端口 */
export function renderPage(template, port) {
  return String(template).replace(/__PORT__/g, String(port));
}
