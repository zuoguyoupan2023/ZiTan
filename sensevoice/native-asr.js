/* native-asr.js — 浏览器原生语音识别（Web Speech API · 联网）
 * 用法与 SenseVoiceAsr 对齐，供 index.html 麦克风"原生优先、本地兜底"使用：
 *   <script src="/sensevoice/native-asr.js"></script>
 *   if (NativeAsr.isSupported()) await NativeAsr.start(onResult, onError);
 *
 * 特性：
 *   - 零下载：直接用 Chrome/Edge/Safari 自带的识别（联网；音频可能上传云端，见 README 隐私说明）
 *   - Safari 兼容：webkitSpeechRecognition 前缀 + 只认 isFinal（interimResults 在 Safari 有已知 bug）
 *   - 错误分类：network / service-not-allowed / language-not-supported → 上层可回退本地模型
 * 详见 018（调研：三大浏览器原生语音识别 API）。
 */
(function (global) {
  'use strict';
  const SR = global.SpeechRecognition || global.webkitSpeechRecognition;

  /* 这些错误意味着"联网识别这条路走不通"，上层应回退本地 SenseVoice */
  const CAN_FALLBACK = ['network', 'service-not-allowed', 'language-not-supported'];

  let rec = null;            // 当前识别器
  let onResultCb = null;     // onResult(text)
  let onErrorCb = null;      // onError({code})
  let finalCollected = false;
  let manualStop = false;    // stop() 主动停止后，onend 不再上报 end-no-result

  function isSupported() { return !!SR; }

  /* 开始监听：onResult(text) 得到最终结果；onError({code}) 遇错（aborted 忽略）。
   * 返回 Promise，resolve = 已开始监听，reject = 启动即失败（上层转本地）。 */
  function start(onResult, onError) {
    if (!SR) return Promise.reject(new Error('no-speech-api'));
    onResultCb = onResult;
    onErrorCb = onError || null;
    finalCollected = false;
    manualStop = false;
    return new Promise((resolve, reject) => {
      const r = new SR();
      rec = r;
      r.lang = 'zh-CN';          // 默认中文（中英界面）；后续可做成设置项
      r.continuous = false;      // 说一句识别一句，与本地 ASR 行为一致
      r.interimResults = false;  // Safari 中间结果有 bug，只用 isFinal
      r.maxAlternatives = 1;

      r.onstart = () => resolve();

      r.onresult = (e) => {
        let text = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          if (e.results[i].isFinal) text += e.results[i][0].transcript;
        }
        text = text.trim();
        if (text) { finalCollected = true; if (onResultCb) onResultCb(text); }
      };

      r.onerror = (e) => {
        if (e.error === 'aborted') return;   // 手动 stop() 触发，忽略
        if (onErrorCb) onErrorCb({ code: e.error });
      };

      r.onend = () => {
        // 自然结束但没出结果（如 no-speech），交回上层复位；主动停止或已出结果则不上报
        if (onErrorCb && !finalCollected && !manualStop) onErrorCb({ code: 'end-no-result' });
        rec = null;
      };

      try { r.start(); }
      catch (err) { reject(err); }
    });
  }

  /* 手动停止（放弃本轮） */
  function stop() {
    manualStop = true;
    if (rec) { try { rec.abort(); } catch (e) {} rec = null; }
  }

  /* 环境信息（供调试/展示） */
  function info() {
    return {
      supported: isSupported(),
      ctor: SR ? (global.SpeechRecognition ? 'SpeechRecognition' : 'webkitSpeechRecognition') : null,
      secure: !!global.isSecureContext,
    };
  }

  global.NativeAsr = { isSupported, start, stop, info, CAN_FALLBACK };
})(window);
