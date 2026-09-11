/**
 * ComfyDroid - 角色卡函数桥
 * ------------------------------------------------------------
 * 在 SillyTavern 中把角色卡 JSON 顶层 `functions` 字段里的
 * 三个 ComfyUI 工具动态注册为真实的 function calling 工具：
 *
 *   1. llm_generate_full_comfy_workflow  - 根据画面描述生成 ComfyUI API 工作流 JSON
 *   2. comfy_submit_workflow             - 提交工作流到远程 ComfyUI，返回 prompt_id
 *   3. comfy_check_progress              - 轮询 /history 直到出图，返回图片 URL
 *
 * 前提（SillyTavern 侧）：
 *   - 使用 Chat Completion API（DeepSeek / Custom OpenAI 兼容等）
 *   - 在 AI Response Configuration 面板勾选 "Enable function calling"
 *
 * 角色卡 functions 读取位置（按优先级）：
 *   1. 扩展设置里手动粘贴的 JSON（use_manual 开启时）
 *   2. 角色卡 data.functions（V2 角色卡导入后自定义字段通常保留在此）
 *   3. 角色卡 data.extensions.functions
 *
 * 切换角色 / 聊天（CHAT_CHANGED）时自动重新同步注册。
 */
(function () {
    'use strict';

    if (typeof SillyTavern === 'undefined' || !SillyTavern.getContext) {
        console.warn('[ComfyDroid] SillyTavern 上下文不可用，扩展未加载');
        return;
    }

    const context = SillyTavern.getContext();
    const {
        registerFunctionTool,
        unregisterFunctionTool,
        isToolCallingSupported,
        extensionSettings,
        saveSettingsDebounced,
        eventSource,
        eventTypes,
        characters,
        characterId,
    } = context;

    // ------------------------------------------------------------------
    // 默认设置
    // ------------------------------------------------------------------
    const DEFAULT_SETTINGS = {
        comfy_endpoint: '',          // 远程 ComfyUI 根地址，如 https://xxx.trycloudflare.com
        checkpoint: '',              // 服务端 models/checkpoints 下的模型文件名
        sampler_name: 'euler',
        scheduler: 'normal',
        steps: 28,
        cfg: 7,
        width: 896,
        height: 1152,
        filename_prefix: 'ComfyDroid',
        use_manual: false,           // 为 true 时忽略角色卡，使用 manual_functions
        manual_functions: '',        // 手动粘贴的 functions JSON 数组
    };

    if (!extensionSettings.comfy_droid) {
        extensionSettings.comfy_droid = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    } else {
        extensionSettings.comfy_droid = Object.assign(
            JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
            extensionSettings.comfy_droid
        );
    }
    const settings = extensionSettings.comfy_droid;

    // 已注册的工具名集合，用于同步增删
    const registeredNames = new Set();

    // 供 check_progress 兜底使用的最近一次 prompt_id
    let lastPromptId = '';
    // 最近一次生成的工作流 JSON（供 submit 缺省参数时兜底使用）
    let lastWorkflowJson = '';

    // 只把这四个已知函数注册为真实工具，其余函数名忽略
    const SUPPORTED_TOOLS = ['comfy_generate_image', 'llm_generate_full_comfy_workflow', 'comfy_submit_workflow', 'comfy_check_progress'];

    // 内置默认函数定义：角色卡读不到 functions 时兜底使用
    const DEFAULT_FUNCTIONS = [
        {
            name: 'comfy_generate_image',
            displayName: '生成图片',
            description: '一站式绘图函数：根据画面描述直接生成图片并返回图片链接，自动完成“生成工作流→提交Comfy→轮询出图”全部流程，只需一次调用。当用户要求画/生成/绘制任何图片时，必须调用本函数（建议按当前角色的风格与视角撰写英文正向提示词）。',
            parameters: {
                type: 'object',
                properties: {
                    positive: { type: 'string', description: '正向提示词，英文为主，写实风格，细节丰富（可融入当前角色的描写风格）' },
                    negative: { type: 'string', description: '反向负面提示词，畸形、水印、低画质等' },
                    width: { type: 'integer', description: '图片宽度，默认896' },
                    height: { type: 'integer', description: '图片高度，默认1152' },
                    steps: { type: 'integer', description: '采样步数，默认28' },
                    cfg: { type: 'number', description: 'CFG参数，默认7' },
                },
                required: ['positive'],
            },
        },
        {
            name: 'llm_generate_full_comfy_workflow',
            displayName: '生成ComfyUI工作流',
            description: '根据用户的画面提示词生成 ComfyUI 工作流（正向提示词、反向负面词、尺寸、步数、CFG）。调用后请紧接着调用 comfy_submit_workflow 提交（无需再传工作流内容，扩展会自动使用刚生成的工作流）。',
            parameters: {
                type: 'object',
                properties: {
                    positive: { type: 'string', description: '正向提示词，英文为主，写实风格，细节丰富' },
                    negative: { type: 'string', description: '反向负面提示词，畸形、水印、低画质等' },
                    width: { type: 'integer', description: '图片宽度，默认896' },
                    height: { type: 'integer', description: '图片高度，默认1152' },
                    steps: { type: 'integer', description: '采样步数，默认28' },
                    cfg: { type: 'number', description: 'CFG参数，默认7' },
                },
                required: ['positive', 'negative'],
            },
        },
        {
            name: 'comfy_submit_workflow',
            displayName: '提交工作流到Comfy',
            description: '将 ComfyUI 工作流提交到远程 Comfy 服务器 API，返回 prompt_id。workflow_json 参数可省略：省略时自动提交扩展内刚生成的工作流（推荐直接省略，避免超长 JSON 截断）。',
            parameters: {
                type: 'object',
                properties: {
                    workflow_json: { type: 'string', description: '（可选）完整 comfy 工作流 json 字符串；不传则自动使用刚生成的工作流' },
                },
            },
        },
        {
            name: 'comfy_check_progress',
            displayName: '查询出图进度',
            description: '查询ComfyUI绘图任务进度，任务完成后返回图片地址（markdown链接）。',
            parameters: {
                type: 'object',
                properties: {
                    prompt_id: { type: 'string', description: '提交任务返回的prompt_id' },
                },
                required: ['prompt_id'],
            },
        },
    ];

    // ------------------------------------------------------------------
    // 读取角色卡 functions
    // ------------------------------------------------------------------
    function getCurrentCharacter() {
        if (characterId === undefined || characterId === null || characterId < 0) return null;
        return (characters && characters[characterId]) || null;
    }

    function readCharacterFunctions() {
        // 手动模式优先
        if (settings.use_manual && settings.manual_functions) {
            try {
                const parsed = JSON.parse(settings.manual_functions);
                if (Array.isArray(parsed)) return parsed;
            } catch (e) {
                console.warn('[ComfyDroid] 手动 functions JSON 解析失败：', e);
            }
        }
        const char = getCurrentCharacter();
        let fns = [];
        if (char) {
            const data = char.data || {};
            fns = data.functions;
            if (!Array.isArray(fns) && data.extensions && Array.isArray(data.extensions.functions)) {
                fns = data.extensions.functions;
            }
        }
        if (Array.isArray(fns) && fns.length > 0) return fns;
        // 兜底：角色卡未提供 functions 时，使用内置默认三函数定义
        console.warn('[ComfyDroid] 角色卡未提供 functions，使用内置默认定义');
        return JSON.parse(JSON.stringify(DEFAULT_FUNCTIONS));
    }

    // ------------------------------------------------------------------
    // 三个工具的真实实现
    // ------------------------------------------------------------------

    // 1) 生成 ComfyUI API 格式工作流 JSON（SDXL 标准模板，节点编号固定）
    async function actionBuildWorkflow(args) {
        const a = args || {};
        const width = a.width || settings.width;
        const height = a.height || settings.height;
        const steps = a.steps || settings.steps;
        const cfg = a.cfg !== undefined && a.cfg !== null ? a.cfg : settings.cfg;
        const positive = a.positive || '';
        const negative = a.negative || '';

        if (!settings.checkpoint) {
            return JSON.stringify({ error: '未配置 checkpoint 模型名，请在扩展设置中填写（Comfy 服务端 models/checkpoints 下的文件名）' });
        }

        const workflow = {
            '3': {
                class_type: 'KSampler',
                inputs: {
                    seed: Math.floor(Math.random() * 1000000000000000),
                    steps: steps,
                    cfg: cfg,
                    sampler_name: settings.sampler_name,
                    scheduler: settings.scheduler,
                    denoise: 1,
                    model: ['4', 0],
                    positive: ['6', 0],
                    negative: ['7', 0],
                    latent_image: ['5', 0],
                },
            },
            '4': {
                class_type: 'CheckpointLoaderSimple',
                inputs: { ckpt_name: settings.checkpoint },
            },
            '5': {
                class_type: 'EmptyLatentImage',
                inputs: { width: width, height: height, batch_size: 1 },
            },
            '6': {
                class_type: 'CLIPTextEncode',
                inputs: { text: positive, clip: ['4', 1] },
            },
            '7': {
                class_type: 'CLIPTextEncode',
                inputs: { text: negative, clip: ['4', 1] },
            },
            '8': {
                class_type: 'VAEDecode',
                inputs: { samples: ['3', 0], vae: ['4', 2] },
            },
            '9': {
                class_type: 'SaveImage',
                inputs: { filename_prefix: settings.filename_prefix, images: ['8', 0] },
            },
        };
        const json = JSON.stringify(workflow);
        lastWorkflowJson = json; // 记住本次工作流，供 submit 缺省参数使用
        return json;
    }

    // 2) 提交工作流到远程 ComfyUI
    async function actionSubmitWorkflow(args) {
        const a = args || {};
        if (!settings.comfy_endpoint) {
            return JSON.stringify({ error: '未配置 Comfy 服务地址，请在扩展设置中填写' });
        }
        let workflowJson = a.workflow_json;
        // 未传或传空时，自动使用最近一次生成的工作流
        if ((!workflowJson || !String(workflowJson).trim()) && lastWorkflowJson) {
            workflowJson = lastWorkflowJson;
        }
        if (!workflowJson) {
            return JSON.stringify({ error: '缺少 workflow_json 参数，且没有已生成的工作流可提交（请先调用 llm_generate_full_comfy_workflow）' });
        }
        let workflow;
        try {
            workflow = JSON.parse(workflowJson);
        } catch (e) {
            return JSON.stringify({ error: 'workflow_json 不是合法 JSON：' + e.message });
        }

        const base = settings.comfy_endpoint.replace(/\/+$/, '');
        const clientId = 'comfy-droid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
        try {
            const resp = await fetch(base + '/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: workflow, client_id: clientId }),
            });
            const data = await resp.json();
            if (data && data.prompt_id) {
                lastPromptId = data.prompt_id;
            }
            return JSON.stringify(data);
        } catch (e) {
            return JSON.stringify({ error: '提交失败（检查服务地址/网络）：' + e.message });
        }
    }

    // 3) 轮询任务进度并取图
    async function actionCheckProgress(args) {
        const a = args || {};
        const pid = a.prompt_id || lastPromptId;
        if (!pid) {
            return JSON.stringify({ status: 'error', message: '缺少 prompt_id' });
        }
        if (!settings.comfy_endpoint) {
            return JSON.stringify({ status: 'error', message: '未配置 Comfy 服务地址' });
        }
        const base = settings.comfy_endpoint.replace(/\/+$/, '');

        try {
            // 先查执行历史：任务完成时 history 里才有 outputs
            const histResp = await fetch(base + '/history/' + encodeURIComponent(pid));
            const history = await histResp.json();
            const entry = history && history[pid];

            if (!entry) {
                // 尚未出结果：查队列判断是排队还是运行中
                let status = 'pending';
                try {
                    const qResp = await fetch(base + '/queue');
                    const q = await qResp.json();
                    if (q && Array.isArray(q.queue_running) && q.queue_running.some((x) => x && x[1] === pid)) status = 'running';
                    else if (q && Array.isArray(q.queue_pending) && q.queue_pending.some((x) => x && x[1] === pid)) status = 'queued';
                } catch (e) { /* 队列查询失败则维持 pending */ }
                return JSON.stringify({ status: status, prompt_id: pid, message: '任务尚未完成，请继续轮询' });
            }

            // 任务已完成：收集图片
            const outputs = entry.outputs || {};
            const images = [];
            for (const nodeId of Object.keys(outputs)) {
                const out = outputs[nodeId];
                if (!out || !Array.isArray(out.images)) continue;
                for (const img of out.images) {
                    const url = base + '/view?filename=' + encodeURIComponent(img.filename)
                        + '&subfolder=' + encodeURIComponent(img.subfolder || '')
                        + '&type=' + encodeURIComponent(img.type || 'output');
                    images.push({
                        filename: img.filename,
                        subfolder: img.subfolder || '',
                        type: img.type || 'output',
                        url: url,
                    });
                }
            }

            if (images.length === 0) {
                return JSON.stringify({ status: 'done', prompt_id: pid, images: [], message: '任务完成，但没有图片输出' });
            }

            const first = images[0];
            return JSON.stringify({
                status: 'done',
                prompt_id: pid,
                images: images,
                image_url: first.url,
                markdown: '![image](' + first.url + ')',
            });
        } catch (e) {
            return JSON.stringify({ status: 'error', message: '查询失败：' + e.message });
        }
    }

    // ------------------------------------------------------------------
    // 一站式绘图：生成工作流 + 提交 + 轮询出图，一次调用完成
    // ------------------------------------------------------------------
    function sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async function actionGenerateImage(args) {
        const a = args || {};
        if (!settings.comfy_endpoint) {
            return JSON.stringify({ error: '未配置 Comfy 服务地址，请在扩展设置中填写' });
        }
        if (!settings.checkpoint) {
            return JSON.stringify({ error: '未配置 checkpoint 模型名，请在扩展设置中填写' });
        }
        const positive = a.positive || '';
        if (!String(positive).trim()) {
            return JSON.stringify({ error: '缺少正向提示词 positive' });
        }

        // 1) 生成工作流（内部会保存 lastWorkflowJson）
        const json = await actionBuildWorkflow(a);
        let workflow;
        try {
            workflow = JSON.parse(json);
        } catch (e) {
            return json;
        }

        // 2) 提交
        const submitRaw = await actionSubmitWorkflow({ workflow_json: json });
        let sub;
        try {
            sub = JSON.parse(submitRaw);
        } catch (e) {
            return JSON.stringify({ error: '提交响应解析失败：' + submitRaw });
        }
        const pid = sub && sub.prompt_id;
        if (!pid) {
            return JSON.stringify({ error: '提交失败：' + (sub.error || submitRaw) });
        }

        // 3) 轮询出图（最长 120 秒，每 2 秒一次）
        for (let i = 0; i < 60; i++) {
            await sleep(2000);
            let res;
            try {
                res = JSON.parse(await actionCheckProgress({ prompt_id: pid }));
            } catch (e) {
                continue;
            }
            if (res.status === 'done') {
                return JSON.stringify(res);
            }
            if (res.status === 'error') {
                return JSON.stringify(res);
            }
        }
        return JSON.stringify({ status: 'timeout', prompt_id: pid, message: '轮询超时（120秒），可调用 comfy_check_progress 继续查询' });
    }

    // ------------------------------------------------------------------
    // 把角色卡函数描述转换成 ST 工具定义
    // ------------------------------------------------------------------
    function makeTool(fn) {
        const name = fn.name;
        let action;
        switch (name) {
            case 'comfy_generate_image':
                action = actionGenerateImage;
                break;
            case 'llm_generate_full_comfy_workflow':
                action = actionBuildWorkflow;
                break;
            case 'comfy_submit_workflow':
                action = actionSubmitWorkflow;
                break;
            case 'comfy_check_progress':
                action = actionCheckProgress;
                break;
            default:
                console.warn('[ComfyDroid] 忽略未知函数：', name);
                return null;
        }
        return {
            name: name,
            displayName: fn.displayName || name,
            description: fn.description || 'ComfyUI 绘图工具',
            parameters: fn.parameters || {
                $schema: 'http://json-schema.org/draft-04/schema#',
                type: 'object',
                properties: {},
            },
            action: action,
            formatMessage: (callArgs) => {
                const brief = callArgs && Object.keys(callArgs).length
                    ? ' ' + Object.keys(callArgs).slice(0, 2).map((k) => k + '=' + String(callArgs[k]).slice(0, 40)).join(', ')
                    : '';
                return '[ComfyDroid] 调用 ' + name + brief + '...';
            },
        };
    }

    // ------------------------------------------------------------------
    // 同步注册 / 注销（角色卡切换或设置变更时调用）
    // ------------------------------------------------------------------
    function syncTools() {
        if (!isToolCallingSupported || !isToolCallingSupported()) {
            console.warn('[ComfyDroid] 当前 API 不支持 function calling 或未在设置中启用，工具未注册');
            return;
        }
        const fns = readCharacterFunctions();
        const wanted = new Set();
        fns.forEach((fn) => {
            if (fn && fn.name) wanted.add(fn.name);
        });

        // 注销已不存在的工具
        registeredNames.forEach((name) => {
            if (!wanted.has(name)) {
                try { unregisterFunctionTool(name); } catch (e) { /* 忽略 */ }
                registeredNames.delete(name);
            }
        });

        // 注册新工具（只支持三个已知函数）
        fns.forEach((fn) => {
            if (!fn || !fn.name) return;
            if (registeredNames.has(fn.name)) return;
            if (!SUPPORTED_TOOLS.includes(fn.name)) return;
            const tool = makeTool(fn);
            if (tool) {
                try {
                    registerFunctionTool(tool);
                    registeredNames.add(fn.name);
                    console.log('[ComfyDroid] 已注册工具：' + fn.name);
                } catch (e) {
                    console.error('[ComfyDroid] 注册失败 ' + fn.name + '：', e);
                }
            }
        });
    }

    // ------------------------------------------------------------------
    // 设置面板 UI（注入扩展设置区）
    // ------------------------------------------------------------------
    function renderSettings() {
        const html = `
        <div class="comfy-droid-settings">
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>ComfyDroid 设置</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <small>角色卡 functions 字段中定义的三个工具会自动注册。在此填写 Comfy 服务连接参数。</small>
              <label class="checkbox_label" for="cd_use_manual">
                <input type="checkbox" id="cd_use_manual"> 使用手动函数定义（忽略角色卡 functions）
              </label>
              <div style="margin-top:8px;">
                <label for="cd_endpoint">Comfy 服务地址（含协议，如 https://xxx.trycloudflare.com）</label>
                <input id="cd_endpoint" class="text_pole" placeholder="https://...">
              </div>
              <div style="margin-top:8px;">
                <label for="cd_ckpt">Checkpoint 模型名（Comfy 服务端 models/checkpoints 下文件名）</label>
                <input id="cd_ckpt" class="text_pole" placeholder="sd_xl_base_1.0.safetensors">
              </div>
              <div style="margin-top:8px;">
                <label for="cd_sampler">采样器 / 调度器</label>
                <input id="cd_sampler" class="text_pole" style="width:45%;" placeholder="euler">
                <input id="cd_scheduler" class="text_pole" style="width:45%;" placeholder="normal">
              </div>
              <div style="margin-top:8px;">
                <label for="cd_size">默认尺寸 宽×高 / 步数 / CFG</label>
                <input id="cd_width" class="text_pole" style="width:20%;" placeholder="896">
                <input id="cd_height" class="text_pole" style="width:20%;" placeholder="1152">
                <input id="cd_steps" class="text_pole" style="width:15%;" placeholder="28">
                <input id="cd_cfg" class="text_pole" style="width:15%;" placeholder="7">
              </div>
              <div style="margin-top:8px;">
                <label for="cd_manual">手动 functions JSON（覆盖角色卡，数组格式）</label>
                <textarea id="cd_manual" class="text_pole" rows="6" style="width:100%;" placeholder='[{"name":"llm_generate_full_comfy_workflow","description":"...","parameters":{"type":"object","properties":{}}}]'></textarea>
              </div>
            </div>
          </div>
        </div>`;
        const container = document.getElementById('extensions_settings');
        if (!container) return;
        container.insertAdjacentHTML('beforeend', html);

        // 回填当前值
        const setVal = (id, value) => {
            const el = document.getElementById(id);
            if (el) el.value = value;
        };
        setVal('cd_endpoint', settings.comfy_endpoint);
        setVal('cd_ckpt', settings.checkpoint);
        setVal('cd_sampler', settings.sampler_name);
        setVal('cd_scheduler', settings.scheduler);
        setVal('cd_width', settings.width);
        setVal('cd_height', settings.height);
        setVal('cd_steps', settings.steps);
        setVal('cd_cfg', settings.cfg);
        setVal('cd_manual', settings.manual_functions);
        const useManualEl = document.getElementById('cd_use_manual');
        if (useManualEl) useManualEl.checked = !!settings.use_manual;

        // 绑定保存
        const bindSave = (id, key, coerce) => {
            const el = document.getElementById(id);
            if (!el) return;
            el.addEventListener('input', () => {
                let v = el.value;
                if (coerce === 'int') v = parseInt(v, 10) || DEFAULT_SETTINGS[key];
                if (coerce === 'float') v = parseFloat(v);
                settings[key] = v;
                saveSettingsDebounced();
                if (key === 'use_manual' || key === 'manual_functions') syncTools();
            });
        };
        bindSave('cd_endpoint', 'comfy_endpoint');
        bindSave('cd_ckpt', 'checkpoint');
        bindSave('cd_sampler', 'sampler_name');
        bindSave('cd_scheduler', 'scheduler');
        bindSave('cd_width', 'width', 'int');
        bindSave('cd_height', 'height', 'int');
        bindSave('cd_steps', 'steps', 'int');
        bindSave('cd_cfg', 'cfg', 'float');
        bindSave('cd_manual', 'manual_functions');
        if (useManualEl) {
            useManualEl.addEventListener('change', () => {
                settings.use_manual = useManualEl.checked;
                saveSettingsDebounced();
                syncTools();
            });
        }
    }

    // ------------------------------------------------------------------
    // 初始化
    // ------------------------------------------------------------------
    function init() {
        // 设置面板
        const tryRender = () => {
            if (document.getElementById('extensions_settings')) {
                renderSettings();
                return true;
            }
            return false;
        };
        if (!tryRender()) {
            // 等 DOM 就绪后重试
            const timer = setInterval(() => {
                if (tryRender()) clearInterval(timer);
            }, 500);
            setTimeout(() => clearInterval(timer), 10000);
        }

        // 首次注册
        syncTools();

        // 切换角色 / 聊天时重新同步
        if (eventSource && eventTypes) {
            eventSource.on(eventTypes.CHAT_CHANGED, syncTools);
        }
        console.log('[ComfyDroid] 扩展已加载。当前可用工具：', Array.from(registeredNames));
    }

    if (typeof document !== 'undefined' && document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
