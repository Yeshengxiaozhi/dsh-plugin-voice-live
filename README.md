# dsh-plugin-voice-live

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web UI 用的**实时语音对话插件**：
点一下麦克风，说话，自动识别、自动发送、自动朗读回复；你随时可以打断。

> 包名遵循 `dsh-plugin-*` 前缀，和社区里 `dsh-plugin-whale-pet` 这类插件一致；
> 浏览器产物注册的模块 id、bundle 清单和 patch 入口都用同一个名字。

```
🎙 麦克风 → 能量 VAD → 16k WAV → 宿主 SenseVoice 识别
                                        ↓
                              session.prompt（当前会话）
                                        ↓
         🔊 流式 PCM 播放 ← 切句/去 Markdown ← assistant 流式文字
                                        ↓
                      Qwen3-TTS（本地 MLX，OpenAI 兼容接口）
```

整条链路跑在浏览器里，复用 Harness 已有的 `sessions` 和 `remote.speech` 服务，
Host 半是空实现——不新增端口、不新增鉴权面。

## 能力

- **说话即对话**：停顿 1.1 秒自动结束，识别后直接发送，不用按键
- **随时打断**：播放中说“等一下”立刻停播并取消当前回合；思考中说也会直接作废
- **本地合成**：Qwen3-TTS 0.6B，Apple Silicon 上跑 MLX，不联网、零成本
- **可调音色与语气**：9 个预置音色 + 自然语言语气指令
- **不做无用功**：代码块、表格、URL 不念；超长回答只念前 220 字

## 前置条件

1. **Harness profile** 需要启用 `@deepseek-ai/dsh-experimental-voice-input-bundle`
   ——它挂载 `remote.speech` 这个 namespace，没有它本插件不会激活
2. **Apple Silicon Mac**（M1–M4），Python 3.10+
3. 首次运行会下载约 1.2 GB 模型权重

## 安装

```bash
git clone <this repo> dsh-plugin-voice-live && cd dsh-plugin-voice-live

# 1. 推理环境
python3 -m venv .venv && source .venv/bin/activate
pip install -r tools/requirements.txt

# 2. 启动本地 TTS（后台或另开终端）
python3 tools/tts_server.py --backend mlx \
  --model mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-bf16

# 3. 把插件装进 Harness profile
#    在 Harness 里执行：plugin_manager install_bundle <本目录绝对路径>
```

装好后刷新页面，输入框下方会出现一个蓝色胶囊按钮「语音对话」。

> 输入框工具条里还有一个麦克风，那是 Harness 官方的**听写**：只把文字塞进草稿、不发送、不朗读。
> 蓝色胶囊才是对话。

## 服务参数

| 参数 | 默认 | 说明 |
|---|---|---|
| `--backend` | `torch` | Mac 上必须用 `mlx` |
| `--model` | `Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice` | MLX 用 `mlx-community/...-8bit` 或 `...-bf16` |
| `--temperature` | `0.55` | 采样温度，越低音色越稳（模型默认 0.9） |
| `--stream-audio` | 关 | 分段解码，首声更快但每段之间有接缝 |
| `--streaming-interval` | `0.5` | 配合 `--stream-audio`，每段秒数 |
| `--port` | `8020` | 改了要在插件设置里同步 |
| `--dry-run` | 关 | 不加载模型，返回测试音 |

音色：`Vivian` `Serena` `Uncle_Fu` `Dylan` `Eric` `Ryan` `Aiden` `Ono_Anna` `Sohee`。

## 实测（M4 / 16 GB，0.6B）

| 后端 | 首声 | RTF | 5 秒音频耗时 |
|---|---|---|---|
| torch fp32 (MPS) | 1.4 s | 1.25 | 6.3 s |
| torch bf16 (MPS) | 1.4 s | 1.25 | 6.3 s |
| MLX 8bit | 0.13 s | 0.48 | 2.4 s |
| **MLX bf16** | **0.2 s** | **0.72** | **3.6 s** |

RTF < 1 才谈得上实时。PyTorch 的 MPS 后端在 M4 上慢于实时，结论是**必须走 MLX**。

## 设计上踩过的坑

- **首尾静音**：模型给每段音频头尾各埋 200–400 ms 静音，两句拼起来就是半秒空白。
  服务端按波形裁剪到 3 ms。
- **分段解码的接缝**：`stream=True` 每 0.5 秒一道缝，波形跳变是正常段的 2.4 倍，
  听感像换了个声音，而且总耗时反而多 34%。默认关闭。
- **短句各自合成**：每句独立采样会让音色漂移，所以短于 11 字不切句。
- **第一声太慢**：关闭分段解码后要等整句合成完，所以第一段在逗号处切短，先出声。
- **打断门槛**：不能拿自己的回声当噪声基准，改为自适应跟踪“自己漏进麦克风的音量”。
- **挪麦克风的摩擦声**：短促爆音会误触发，改成要连续 180 ms 才算开口。

## 目录

```
dsh-plugin-voice-live/
├── package.json          # bundle 清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # 往 profile 里插入一个 Loader 入口
├── index.js              # Host 半（空实现，说明见注释）
├── client.js             # 全部逻辑：采集、VAD、切句、播放、界面
├── locale/{zh,en}.json   # 插件管理页的标题与描述
├── icon.svg
└── tools/
    ├── tts_server.py     # OpenAI 兼容的本地 TTS 服务（torch / MLX 双后端）
    └── requirements.txt
```

## 已知限制

- 按句合成，不是逐字流式，所以句间有合成本身的换气停顿
- RTF 0.72 意味着生成只比播放快 30%，长回复偶尔会有一次短暂空档
- 打断后的新句子以 `steer` 投递；如果正好在做工具调用，可能要等它跑完
- 环境里的抖音、视频声会被当成说话——回声消除只抵消自己放出的声音
- 依赖 Harness 的实验性语音识别 bundle，接口可能随版本变化

## License

MIT
