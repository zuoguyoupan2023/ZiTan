# 001 · 字谈 ZiTan 当前实现总结

> 日期：2026-08-12　·　更新：2026-08-13（新增 §4 语音识别 ASR）　·　目的：快速了解当前 UI / 功能 / 逻辑，供后续查询
> 载体：单文件 `index.html`（+ `manifest.webmanifest`、`sw.js`、`icons/`），原生 HTML/CSS/JS，无构建步骤。

---

## 1. 项目定位

听障朋友与志愿者 / 路人**实时对话辅助**的 Web 应用（PWA）。中英双语。

## 2. 页面布局（自顶向下）

### 顶部 header
- 品牌「字谈」
- 第一行按钮：**清空当前窗口内容**（扫帚图标，title 提示"清空当前窗口内容 /（放心聊天记录不会消失）"，点击弹 confirm）、**设置**（齿轮）、**语言切换** EN / 汉、**明暗切换**（高对比模式）
- 第二行工具：**字号 A− / A+**、**大字展示**、**发送后朗读**开关（默认**开**）

### 聊天区 main
- 消息气泡：听障（绿）在**右侧**、志愿者（蓝）在**左侧**
- 气泡内字号：桌面 28px / 手机 32px（随 A+/A− 的 `--fs` 缩放，0.6~2.2）
- **播放键位置**：绿色气泡的**左侧**、蓝色气泡的**右侧**（`.msg.vol .bubrow { flex-direction: row-reverse }`）
- 点播放键朗读该条；点气泡打开大字展示；空态有提示文案

### 底部 footer
- **快捷用语 chips**：默认显示前 3 个，多于 3 个出现「+N / 收起」（N = 总数−3，自动变化）；**展开后「收起」按钮为红色边框高亮（文字不变红）**；黄边=填入输入框继续写，无黄边=点一下直接发
- **身份行**：左侧「当前是」提示 + 右侧两个按钮（听障朋友 / 志愿者·路人）
  - 未选中：边框/背景中性，**只有文字是绿/蓝色**，无圆点
  - 选中：深绿 / 深蓝底 + 白字 + 圆点
- **输入框 + 发送**：输入框外部上下边距 1px；输入框**左侧有麦克风按钮**（语音输入，见 §4）

## 3. 核心功能与逻辑

| 功能 | 逻辑要点 |
|------|---------|
| 身份切换 | `state.identity = 'deaf'/'vol'`，决定气泡颜色、对齐、归属；`.on` 类切换样式 |
| 发送 | `send()` → `doSend(text)` → push `{by, text, time}` → `render()` → 若朗读开则 `speak()` |
| 朗读 TTS | Web Speech API：`speechSynthesis.cancel()` → `new SpeechSynthesisUtterance` → `pickVoice()` → `speak()` |
| 语音选择 | `state.voiceLang`（语言，LANGS 24 种）+ `state.voiceURI`（具体语音）；`autoPick()` 按偏好名匹配 |
| 安卓语音坑 | `getVoices()` 首调为空 → `kickVoices()` 用静音空串 `speak(' ')` 触发加载 + `voiceschanged` 事件重渲染（**无轮询**） |
| 大字展示 | `presenter` 全屏：上一条/下一条、播放、键盘 ←/→/Esc、触摸滑动 |
| 预设管理 | 两组（听障/志愿者）各自 `{t, k}` 数组：添加（输入+类型）、**点击文字内联编辑**（Enter/失焦保存，Esc 取消）、标签切换 fill/send、**× 删除（带 confirm）**；与快捷用语 `renderQuick()` 联动 |
| 对话历史 | 设置 → 对话历史：列出 IndexedDB 全部 session（时间 / 条数 / 首条预览 / 当前标记），点击某条恢复 `state.messages` 到对话界面并自动进入对话；每条右侧 **× 删除**（带 confirm，删当前会话则清空窗口另开新会话） |
| 语音设置 | 语言下拉 + 语音列表（按语言过滤）+ 试听 |
| 语音输入（ASR） | 点输入框左侧麦克风 → **原生 Web Speech API 优先**、本地 SenseVoice 兜底 → 停顿自动识别填入输入框（详见 §4） |
| 明暗 / 高对比 | `body.hc` + CSS 变量整体换肤 |

## 4. 语音识别（ASR 语音输入）

志愿者/路人说话 → 自动转文字填入输入框。**双路径：优先原生 Web Speech API（联网、零下载），不支持/断网/出错时回退本地离线 SenseVoice。**

- **入口**：输入框左侧麦克风按钮 `#micBtn`（SVG 图标，无 emoji）；录音中再点一次 = 停止
- **流程**：点麦克风 → toast 提示识别方式 → 说话停顿自动识别 → 文字填入输入框 → 麦克风自动复位
  - **原生路径（默认）**：`NativeAsr.start` 后 toast「联网识别中（音频上传云端）…」，说一句自动出最终结果，**不下载模型、秒开**（冒烟测试确认 `modelFetches=0`）
  - **回退路径**：原生不可用 / `network` / `service-not-allowed` / `language-not-supported` 时 toast「联网识别不可用，改用本地模型」→ 懒加载 228MB SenseVoice（toast 进度）→ 停顿 ~0.7s 识别
- **模块**：
  - `sensevoice/native-asr.js`：Web Speech API 封装（`SpeechRecognition || webkitSpeechRecognition` 前缀兼容；只认 `isFinal`——Safari interimResults 有 bug；错误分类 `CAN_FALLBACK` 供上层回退）
  - `sensevoice/sensevoice-asr.js`：本地 DSP + 推理 + 录音 + VAD
  - `index.html` 只加按钮 + 事件绑定 + i18n 文案（micTitle / micNative / micNativeFallback / micLoading / micListening / micNoSpeech / micFail）
- **本地防乱码三层把关**（针对静音/噪音时模型幻觉，如输出「그」「嗯」）：
  1. 能量 VAD：RMS 低于阈值（~1% 满幅）的静音段不进入识别，源头堵住
  2. 整段复查：识别前再算整体 RMS，近静音段丢弃（防呼吸声/点击声溜进来）
  3. 结果过滤：纯标点、单字非中文（如「그」）、纯语气词（嗯/唔/呃）丢弃
- **端点检测**（本地）：说话停顿 0.7s 自动切句；单句上限 10s；过短（<250ms）忽略
- **资源路径**（本地）：默认同站 `/sensevoice`；部署时用 `window.ZITAN_ASR = { base: 'https://…' }` 指到 R2（228MB 模型不随网页走）
- **隐私说明**：原生路径音频上传云端（Google/Azure/Apple）；本地路径不离开设备。隐私敏感场景走本地路径（原生断网即自动回退本地）
- **兼容性**：原生路径 Chrome/Edge（必须联网）/Safari（装了系统语言包才设备端，否则云端）；本地路径需 WASM + https 或 localhost + 用户手势（按钮点击内已触发）
- **相关**：原生调研见 `018`、技术见 `004`、踩坑见 `003`、部署见 `006`

## 5. 存储

- **localStorage**（`LS_KEY = 'zitan-demo-v5'`）：保存整个 `state`（消息 / 预设 / 设置 / 会话 id）
- **IndexedDB**（DB=`zitan`，store=`sessions`）：**会话历史**
  - 每次 `save()` 同时 upsert 当前会话 `{ id: sessionId, start, end, messages }`
  - **清空按钮 → 开新会话**（旧会话留在 IndexedDB 归档）
  - 设置 → 其他 → **导出聊天记录 (JSON)**：导出**全部会话**为 JSON 下载
- 会话模型：`state.sessionId` / `state.sessionStart`；老数据无 sessionId 时自动生成

## 6. 国际化

- `I18N` 对象 `zh` / `en` 两组；`t(key)` 查表（en 缺省回退 zh）
- `data-i18n`（文本）、`data-i18n-ph`（placeholder）、`data-i18n-title`（title）在 `applyLang()` 里统一应用

## 7. 已知语音环境差异

- 桌面 Chrome/Edge、Safari（macOS/iOS）：语音列表正常
- **华为手机等部分安卓**：`getVoices()` 返回空但 `speak()` 有默认语音 → 列表显示提示文案（"部分手机无法显示列表，试听有默认音频"），代码层面无解（取决于设备是否装 Google 语音服务）

## 8. 设置页底部署名

- 小灰字「由[左顾右盼]开发」，名字蓝色下划线可点击，链接到 `https://wewalk.world/`，i18n 双语

## 9. 后续 / 待办

- 预设用语「上传 / 共享」（讨论见 `000-preset-sharing.md`）
- service worker 目前处于开发态（每次清缓存）；上线发布时需改成正式注册缓存
- **ASR 部署未做**：228MB 模型尚未上 R2，前端 `ZITAN_ASR.base` 目前仍是本地 `/sensevoice`；流程见 `006`。**原生优先策略已实现**（分支 `feature/native-speech-api`，冒烟测试通过），不配 R2 也能靠原生 API 联网识别
- 语音识别：原生优先 + 本地兜底已实装；调研见 `018`、真机验证页 `speech-native-test.html`
