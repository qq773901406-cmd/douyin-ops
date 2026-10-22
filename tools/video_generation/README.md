# 免费 Wan2.2 图生视频

这个工具将一张本地首帧和动作提示词提交到已验证的公共 Hugging Face Space。默认匿名使用，不读取本机的 Hugging Face 登录身份，不购买订阅、开通试用或切换账号。一次运行最多提交一个任务。

免费来自该 Space 的共享 ZeroGPU 额度，**不等于无限免费算力**。额度、排队、Space 是否在线及模型配置均由平台决定，可能没有可用额度。额度用完后应等待恢复；不要更换账号、地址或 Space 绕过限制。工具不自动重试生成。

- 开源模型：[Wan-Video/Wan2.2](https://github.com/Wan-Video/Wan2.2)
- 已验证的公共服务：[Wan2.2 14B Fast Space](https://huggingface.co/spaces/zerogpu-aoti/wan2-2-fp8da-aoti-faster)
- 平台说明：[ZeroGPU 使用额度](https://huggingface.co/docs/hub/spaces-zerogpu#usage-tiers)

## 安装和运行

需要 Python 3.10 或以上。以下命令从项目根目录执行；示例中的输入图片和提示词文件需由你准备。

```powershell
python -m pip install -r tools/video_generation/requirements-free.txt
python tools/video_generation/free_wan.py --image inputs/keyframe.jpg --prompt-file inputs/motion.txt --out-dir runtime/wan-job-001 --duration 3.5 --seed 42
```

`--prompt-file` 使用 UTF-8 文本，也可以换成 `--prompt "The two kittens sway their heads and lift their paws. Fixed camera."`。实际生成会把首帧上传到这个公共服务，因此应使用你愿意交给该服务处理的素材。生成只保存到本地，不发布到抖音或 B 站。

时长允许 0.5–5 秒，默认 3.5 秒；随机种子范围 0–2147483647，默认 42。模型、6 步推理参数和服务地址固定为本次验证过的配置。服务升级或接口变化时工具会报错，不会自动转向付费模型。

如果依赖已经安装在单独目录，可复用该目录：

```powershell
python tools/video_generation/free_wan.py --image inputs/keyframe.jpg --prompt-file inputs/motion.txt --out-dir runtime/wan-job-002 --deps-dir runtime/video-quality-implementation/cat-duet-sample/python-deps
```

正常 Python 环境优先；仅在导入 `gradio_client` 或其依赖时找不到模块，才将 `--deps-dir` 加到模块搜索路径末尾。工具要求已验证的版本 `2.7.2`，不会自行安装或升级依赖。

## 离线检查

以下命令不需要安装 Gradio，不访问网络、不创建输出目录，也不消耗额度：

```powershell
python tools/video_generation/free_wan.py --help
python tools/video_generation/free_wan.py --image inputs/keyframe.jpg --prompt-file inputs/motion.txt --out-dir runtime/wan-job-003 --dry-run
```

检查包括文件可读、JPEG/PNG/WebP 文件头、非空提示词、时长、种子以及输出目录尚不存在；不会完整解码图像，也不能证明服务有额度或远端接口仍可用。

## 输出和中断处理

每次运行必须使用一个尚不存在的 `--out-dir`。工具会独占创建该目录，并在调用生成接口前持久化 `request.json`，因此并发运行和中途中断后都不能用同一个目录再次提交。即使目录为空，或状态是 `submitting`、`submitted`、`running`、`downloading`、`unknown`、`completed`，也不会覆盖或重试。

成功后目录包含 `video.mp4`、首帧副本和 `request.json`。回执保存参数、首帧 SHA-256、服务会话标识、取得的事件标识以及结果位置。回执与素材属于本机运行数据，应保存在 `runtime/`，不要作为通用模板提交。

提交开始后的网络错误、服务报错、Ctrl+C、12 分钟等待超时以及下载失败都会记为 `unknown`，保守地阻止重复消耗额度；这不代表服务一定成功或失败。CLI 停止等待不会确认远端任务已取消。应先检查回执和服务状态，不能删目录或改状态以绕过保护。

下载在服务器结果写入回执后开始。若下载中断，`result`、`download_url`、`session_hash`、可获得的 `event_id` 和部分文件会保留下来，可据此人工检查原任务或仅取回原结果。服务临时文件可能过期；工具不承诺能恢复任务，也不自动重新生成。只有确认原任务状态、确实要创建另一条视频时，才选择新的输出目录。

## 已验证的画质边界

项目里已用该 Space 匿名生成双猫动作样片：5.0625 秒、480×832、16 帧/秒、无音轨。黑白猫可完成抱头、晃头和伸爪，后景橘猫动作偏小；角色和房间在抽帧中基本稳定，但流畅度未达到参考片。这个结果证明免费路线可用，不保证后续任务相同画质，也不代表所有帧的肢体都已通过审核。

模型输出尺寸由服务处理，工具不把低分辨率标成高清，不补帧，不自动配乐。先用短而明确的单镜头动作验证首帧、角色和动作，再决定是否制作更多镜头。可复用 CLI 本身只做过离线校验；上述实测视频来自封装前的同服务、同参数流程。
