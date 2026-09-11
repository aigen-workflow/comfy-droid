# ComfyDroid 扩展 - 部署与使用指南

让 SillyTavern 读取角色卡 JSON 顶层的 `functions` 字段，并把其中三个 ComfyUI 工具

**动态注册为真实的 function calling 工具**，真正连通远程 ComfyUI 服务出图。



***

## 一、整体架构



```
用户（梦客）

&#x20;  │  发送画面描述

&#x20;  ▼

SillyTavern ─────────────────────────────────────────────┐

&#x20; │ 角色卡 functions 字段                                  │

&#x20; │   ├─ llm\_generate\_full\_comfy\_workflow                 │

&#x20; │   ├─ comfy\_submit\_workflow                            │

&#x20; │   └─ comfy\_check\_progress                             │

&#x20; │   └─▶ ComfyDroid 扩展（registerFunctionTool ×3）       │

&#x20; ▼                                                       │

LLM（DeepSeek / OpenAI 兼容，Chat Completion）             │

&#x20; │  模型决定调用哪个工具，返回 function\_call               │

&#x20; ▼                                                       │

ComfyDroid 扩展执行 action（fetch）                        │

&#x20; ├─ 生成工作流 JSON（SDXL 模板）                           │

&#x20; ├─ POST {comfy}/prompt        → prompt\_id               │

&#x20; └─ GET  {comfy}/history/{id}  → 图片 URL                 │

&#x20; ▼                                                       │

远程 ComfyUI（http://127.0.0.1:8188 或 trycloudflare 隧道）◀┘

&#x20; └─ /view?filename=... 返回图片给 SillyTavern 聊天展示
```

## 二、文件清单



```
comfy-droid/

├── manifest.json   # 扩展元数据（已写好，无需改动）

├── index.js        # 核心逻辑：动态注册 + 三个工具实现（已写好）

└── README.md       # 本文档
```

## 三、安装步骤（Windows）

### 1. 放置扩展

把 `comfy-droid` 整个文件夹复制到 SillyTavern 的用户扩展目录：



```
SillyTavern\\

└── data\\

&#x20;   └── <你的用户名>\          # 默认是 default-user

&#x20;       └── extensions\\

&#x20;           └── comfy-droid\\

&#x20;               ├── manifest.json

&#x20;               └── index.js
```

> 提示：如果已有 
>
> `SillyTavern\data\default-user\extensions`
>
>  目录就直接放进去；
> 没有就按路径新建。不要放进 
>
> `public/scripts/extensions`
>
> （那是内置 / 第三方下载区）。

### 2. 重启 SillyTavern

重启后浏览器打开 SillyTavern 页面，右上角扩展面板（积木图标）应能看到

**"ComfyDroid - 角色卡函数桥"**，且扩展设置区出现 "ComfyDroid 设置" 抽屉。

### 3. 启用 function calling（关键！）



* 确认 API 源为 **Chat Completion** 类：

  `API 连接` → 选择 **DeepSeek** 或 **Custom（OpenAI 兼容）**，填好你的 API 地址与 Key。

* 打开 **AI 回复配置（AI Response Configuration）** 面板，勾选

  **"Enable function calling"**。

  （递归限制保持默认 5 轮即可，本链路最多 3 次工具调用）

### 4. 配置扩展参数

扩展设置面板中填写：



| 字段              | 说明                                 | 示例                                                           |
| --------------- | ---------------------------------- | ------------------------------------------------------------ |
| Comfy 服务地址      | 远程 ComfyUI 根地址，**含协议**，末尾不带斜杠      | `https://transit-therefore-texas-nicholas.trycloudflare.com` |
| Checkpoint 模型名  | 服务端 `models/checkpoints` 目录下的模型文件名 | `sd_xl_base_1.0.safetensors`                                 |
| 采样器 / 调度器       | 默认 `euler` / `normal`，按你服务端的采样器清单填 | `euler` / `normal`                                           |
| 默认尺寸 / 步数 / CFG | 工具未传参时的兜底值                         | 896 / 1152 / 28 / 7                                          |

> 若你的 ComfyUI 启用了用户鉴权（ComfyUI-Login 等），还需要在 Comfy 服务端
> 配置允许该客户端访问，或用未鉴权实例 + 隧道暴露。

### 5. 导入角色卡并验证



* 导入你那份 `Comfy_Droid.json`（角色卡顶层已有 `functions` 字段，无需改格式）。

* 新建对话选择该角色，发送："列出你当前可以调用的全部工具名称"。

* 预期回复列出三个工具（不再是只有一个 GenerateImage），并触发 `formatMessage` 提示。

## 四、测试完整出图链路

对话中发送（或直接发画面描述）：



```
画一个赛博朋克风格的女孩，霓虹灯光，雨夜街头，竖构图
```

正常流程（LLM 会自动串联）：



1. `llm_generate_full_comfy_workflow(positive=..., negative=..., width, height, steps, cfg)`

   → 返回 SDXL 工作流 JSON

2. `comfy_submit_workflow(workflow_json)`

   → 返回 `{"prompt_id":"...","number":N}`

3. `comfy_check_progress(prompt_id)`（可能轮询多次）

   → 任务完成后返回 `image_url` 与 `![image](url)`

4. 聊天里直接显示生成的图片

## 五、常见问题



| 现象                          | 原因与处理                                                                                                                                              |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展列表里没有 ComfyDroid          | 目录放错位置；确认在 `data/<user>/extensions/comfy-droid/`，重启 ST                                                                                             |
| 工具未注册（角色仍说只有 GenerateImage） | ① 没勾选 "Enable function calling"；② API 源不是 Chat Completion；③ 角色卡 functions 字段不在 `data.functions`（V2 导入后自定义字段一般保留在此），可用设置面板 "手动 functions JSON" 粘贴覆盖 |
| 提交时报网络错误                    | trycloudflare 隧道地址是临时的，重启隧道后地址会变，需更新设置；或 ComfyUI 服务未启动                                                                                             |
| 一直 pending                  | 服务端队列未执行（模型未加载 / 爆显存），检查 ComfyUI 日志；轮询由 LLM 发起，最多约 5 轮递归，超时会中断                                                                                     |
| 模型名报错                       | 扩展里 checkpoint 填的是服务端模型文件名，不是 API 模型名；API 模型名在 ST 的 API 连接里配                                                                                       |

## 六、SillyDroid（安卓直装版）安装

SillyDroid 是 SillyTavern 的安卓直装版（单 APK，内置 Linux 运行时 + 内置 WebView），
随主线版本（当前约 1.18.0）自带 function calling，扩展机制与电脑版完全同构。

> 数据目录（源码确认）：扩展放在应用私有目录下的
> `android-tavern/data/server/data/default-user/extensions/`
> ——与电脑版 `data/<user>/extensions` 一一对应。
> 该目录在 Android 上属于应用私有区，普通文件管理器无法直接写入，
> 因此推荐下面三种安装方式中的前两种。

### 方式一：电脑版导出用户备份 → 手机导入（最稳，全程离线）

1. 电脑上把 `comfy-droid` 文件夹放进本地 SillyTavern 的
   `data/default-user/extensions/` 下（没有本地 ST 就按此路径临时建目录结构）。
2. 电脑版 ST：设置 → 用户设置 → 备份 → **导出用户数据**，得到 ZIP（该备份包含
   `extensions` 目录）。
3. 把 ZIP 传到手机，打开 SillyDroid → 设置中心 → **数据迁移 → 导入**，选择该 ZIP。
4. SillyDroid 自动识别为"用户备份"，解压到 `data/default-user`，扩展随之就位。
5. 刷新 / 重启 App，扩展面板出现 ComfyDroid。

### 方式二：Git 仓库 + 扩展面板安装（手机在线装）

1. 把 `comfy-droid` 文件夹推到你的 Git 仓库（GitHub / Gitee 均可）。
2. 手机 SillyDroid 内置 WebView 里打开 ST 界面 → 扩展面板 → **Install Extension**，
   粘贴仓库 URL（仓库根目录需含 `manifest.json`）。
3. 安装后刷新页面，扩展出现在管理列表。
   （注意：从 GitHub 安装需要手机能访问 GitHub；大陆网络不稳时换 Gitee 或方式一）

### 方式三：直接放文件（需要特殊文件管理器）

数据目录在 `/data/data/com.jm.sillydroid/files/android-tavern/data/server/data/default-user/extensions/`，
需要用 MT 管理器 + Shizuku（或 root）访问应用私有目录，把 `comfy-droid` 文件夹复制进去后重启 App。
普通用户不推荐，仅作为备选。

### 安装后的配置（与电脑版相同）

- API 连接：DeepSeek 或 Custom（OpenAI 兼容），**勾选 Enable function calling**。
- 扩展设置：填 Comfy 服务地址（https 隧道）与 checkpoint 模型名。
- 导入 `Comfy_Droid.json` 角色卡，发画面描述测试三函数链路。

## 七、机制说明（为什么这样就能"真正绑定"）



* SillyTavern 的 `registerFunctionTool()` 会把工具定义注入每次 Chat Completion 请求的

  `tools` 字段，模型返回 `function_call` 后由扩展的 `action` 真实执行（fetch 到远程

  ComfyUI 的 `/prompt`、`/history`、`/view`）。

* 角色卡的 `functions` 字段本身只是描述；**本扩展负责把它变成运行时工具**，并在

  切换角色（`CHAT_CHANGED` 事件）时自动重新注册 / 注销，实现 "换卡即换工具"。

* 三个工具的 action 实现已内置于 `index.js`，函数名与角色卡一一对应；

  其他名字的函数会被忽略（避免角色卡注入不可控代码）。