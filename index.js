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
        inject_prompt: true,         // 为 true 时向用户消息注入“绘图工具可用”提示，压制预设对工具调用的干扰
        pose_enabled: true,          // 为 true 时，复杂双人动作自动从姿势图库选图锁姿势
        pose_strength: 0.7,          // ControlNet 姿势控制强度（0.65~0.75 推荐）
        pose_controlnet: 'control_v11p_sd15_openpose.pth', // 服务端 models/controlnet 下的 OpenPose 模型
        pose_library_dir: 'pose_library', // 姿势图库目录（相对 Comfy 服务端 input 目录）
        comic_style: false,          // 为 true 时出图注入漫画渲染风格（黑白/网点线稿）；默认关闭
        realistic_enhance: true,     // 为 true 时出图注入写实增强（默认开启，越接近真实越好）
        quality_gate: true,          // 为 true 时出图后自动运行 QualityGate 人物质量审查，不合格自动换 seed 重试
        quality_retry: 3,            // 质量审查未通过时的最大重试次数（每次换新 seed）
    };

    // 姿势图库索引（与电脑端 Comfy input/pose_library/ 下的图片对应，供 LLM 选姿势）
    // 新增姿势图时：把图放进 pose_library 目录，并在下面加一行；保持与 index.json 一致。
    // 2026-09 新增：Civitai 体位骨架包已复制到 input\pose_library\ 与 input\ 根目录（分类_序号.png）
    const POSE_LIBRARY = [
        // ---- 本地提取骨架（瑜伽/舞蹈/健身参考）----
        { file: 'throne_pose.jpg', tags: '王座式|男仰卧|女坐男上|女跨坐|坐姿', desc: '男仰卧在地，女跨坐/盘坐在男上方，被男双脚托举' },
        { file: 'lift_pose.jpg', tags: '托举|仰卧托举|男托女|悬空', desc: '男平躺双腿上举托住女双脚，女直立悬空平衡' },
        { file: 'backbend_lift.jpg', tags: '站立托举|托举|后仰', desc: '男屈膝站立托举，女身体后仰弓状被托' },
        { file: 'ballroom_dance.jpg', tags: '交谊舞|牵手|舞蹈|面对面', desc: '男女面对面牵手交谊舞姿态' },
        { file: 'piggyback.jpg', tags: '背背|背负|骑背', desc: '男背女，女骑坐男背上' },
        // ---- Civitai Cowgirl position（女上位跨坐）----
        { file: 'cowgirl_01.png', tags: '女上位|跨坐|男仰卧女在上|cowgirl', desc: '女上位跨坐骨架：女在上方跨坐于仰卧男身上（Civitai Cowgirl position）' },
        // ---- Civitai Missionary position（男上正面，52 变体）----
        { file: 'missionary_01.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 1/52（Civitai Missionary position）' },
        { file: 'missionary_02.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 2/52' },
        { file: 'missionary_03.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 3/52' },
        { file: 'missionary_04.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 4/52' },
        { file: 'missionary_05.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 5/52' },
        { file: 'missionary_06.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 6/52' },
        { file: 'missionary_07.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 7/52' },
        { file: 'missionary_08.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 8/52' },
        { file: 'missionary_09.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 9/52' },
        { file: 'missionary_10.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 10/52' },
        { file: 'missionary_11.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 11/52' },
        { file: 'missionary_12.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 12/52' },
        { file: 'missionary_13.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 13/52' },
        { file: 'missionary_14.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 14/52' },
        { file: 'missionary_15.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 15/52' },
        { file: 'missionary_16.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 16/52' },
        { file: 'missionary_17.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 17/52' },
        { file: 'missionary_18.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 18/52' },
        { file: 'missionary_19.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 19/52' },
        { file: 'missionary_20.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 20/52' },
        { file: 'missionary_21.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 21/52' },
        { file: 'missionary_22.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 22/52' },
        { file: 'missionary_23.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 23/52' },
        { file: 'missionary_24.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 24/52' },
        { file: 'missionary_25.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 25/52' },
        { file: 'missionary_26.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 26/52' },
        { file: 'missionary_27.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 27/52' },
        { file: 'missionary_28.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 28/52' },
        { file: 'missionary_29.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 29/52' },
        { file: 'missionary_30.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 30/52' },
        { file: 'missionary_31.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 31/52' },
        { file: 'missionary_32.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 32/52' },
        { file: 'missionary_33.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 33/52' },
        { file: 'missionary_34.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 34/52' },
        { file: 'missionary_35.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 35/52' },
        { file: 'missionary_36.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 36/52' },
        { file: 'missionary_37.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 37/52' },
        { file: 'missionary_38.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 38/52' },
        { file: 'missionary_39.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 39/52' },
        { file: 'missionary_40.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 40/52' },
        { file: 'missionary_41.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 41/52' },
        { file: 'missionary_42.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 42/52' },
        { file: 'missionary_43.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 43/52' },
        { file: 'missionary_44.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 44/52' },
        { file: 'missionary_45.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 45/52' },
        { file: 'missionary_46.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 46/52' },
        { file: 'missionary_47.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 47/52' },
        { file: 'missionary_48.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 48/52' },
        { file: 'missionary_49.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 49/52' },
        { file: 'missionary_50.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 50/52' },
        { file: 'missionary_51.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 51/52' },
        { file: 'missionary_52.png', tags: '男上正面|面对面|missionary', desc: '男上正面体位骨架变体 52/52' },
        // ---- Girls Going Down / waist-up（跪姿口部、上半身特写）----
        { file: 'oral_01.png', tags: '跪姿|上半身特写|waistup', desc: '跪姿/上半身特写骨架 1（waist-up）' },
        { file: 'oral_02.png', tags: '跪姿|上半身特写|waistup', desc: '跪姿/上半身特写骨架 2（waist-up）' },
        { file: 'oral_03.png', tags: '跪姿|上半身特写|waistup', desc: '跪姿/上半身特写骨架 3（waist-up）' },
        { file: 'oral_04.png', tags: '跪姿|上半身特写|waistup', desc: '跪姿/上半身特写骨架 4（waist-up）' },
        { file: 'oral_05.png', tags: '口部特写|跪姿|OpenPose|Girls Going Down', desc: '口部特写跪姿骨架 OpenPose 变体（Civitai Girls Going Down）' },
        { file: 'oral_06.png', tags: '口部特写|跪姿|OpenPose|Girls Going Down', desc: '口部特写跪姿骨架 OpenPose 变体 2（Civitai Girls Going Down）' },
        // ---- Close up / Upper Body from behind（脸、上半身特写）----
        { file: 'closeup_01.png', tags: '特写|脸|头枕|Close up head rest', desc: '脸/上半身特写骨架（Civitai Close up, head rest）' },
        { file: 'closeup_02.png', tags: '背后上半身|特写|Upper Body from behind', desc: '背后上半身特写骨架（Civitai Upper Body looking from Behind）' },
        { file: 'closeup_03.png', tags: '特写|头枕|Close up head rest', desc: '脸/上半身特写骨架 2（Civitai Close up, head rest）' },
        // ---- 2girls from behind（背后双人，双女骨架，混一男一女时慎用）----
        { file: 'from_behind_03.png', tags: '背后双人|双女|from behind|慎用', desc: '背后双人骨架（Civitai 2girls from behind；该包为双女骨架，需一男一女时慎用）' },
        { file: 'from_behind_04.png', tags: '背后双人|双女|from behind|慎用', desc: '背后双人骨架变体 2（双女骨架，需一男一女时慎用）' },
        // ---- 三人打斗（自绘 OpenPose，2026-09）----
        { file: 'three_fight_01.png', tags: '三人打斗|三人对峙|多人战斗|三人格斗|3人|打斗', desc: '三人打斗骨架（自绘 OpenPose）：左弓步刺击、中双臂格挡、右蓄力出拳' },
    ];

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
            description: '一站式绘图函数：根据画面描述直接生成图片并返回图片链接，自动完成“生成工作流→提交Comfy→轮询出图”全部流程，只需一次调用。当用户要求画/生成/绘制任何图片时，必须调用本函数（建议按当前角色的风格与视角撰写英文正向提示词）。【姿势图库】当用户要求的是复杂双人动作（跨坐、仰卧、跪姿、托举、舞蹈、背背等需要锁定姿势的画面）时，必须从姿势图库中选择最匹配的 pose_file 传入；简单单人/静态画面不传 pose_file。【图库清单】cowgirl_01.png=女上位跨坐；missionary_01~52.png=男上正面（52变体，任选）；oral_01~06.png=跪姿/口部上半身特写；closeup_01~03.png=脸/上半身特写；from_behind_03~04.png=背后双人（双女骨架慎用）；throne_pose.jpg=王座式、lift_pose.jpg=仰卧托举、backbend_lift.jpg=站立托举后仰、ballroom_dance.jpg=交谊舞牵手、piggyback.jpg=背背。【强制】工具返回图片链接后，你必须在最终回复中用 ![image](图片链接) 的 markdown 格式把图片展示给用户；绝对禁止回复“没有新画面，未出图”或任何不包含图片链接的文字。',
            parameters: {
                type: 'object',
                properties: {
                    positive: { type: 'string', description: '正向提示词，英文为主，写实风格，细节丰富（可融入当前角色的描写风格）' },
                    negative: { type: 'string', description: '反向负面提示词，畸形、水印、低画质等' },
                    pose_file: { type: 'string', description: '（可选）姿势图库文件名。复杂双人动作必填：cowgirl_01.png=女上位跨坐、missionary_01~52.png=男上正面、oral_01~06.png=跪姿/口部特写、closeup_01~03.png=脸/上半身特写、from_behind_03~04.png=背后双人(双女慎用)、throne_pose.jpg=王座式、lift_pose.jpg=仰卧托举、backbend_lift.jpg=站立托举后仰、ballroom_dance.jpg=交谊舞牵手、piggyback.jpg=背背。选最接近用户动作的一张' },
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
            description: '根据用户的画面提示词生成 ComfyUI 工作流（正向提示词、反向负面词、尺寸、步数、CFG）。【姿势图库】复杂双人动作时传 pose_file 锁姿势，图库同 comfy_generate_image。调用后请紧接着调用 comfy_submit_workflow 提交（无需再传工作流内容，扩展会自动使用刚生成的工作流）。',
            parameters: {
                type: 'object',
                properties: {
                    positive: { type: 'string', description: '正向提示词，英文为主，写实风格，细节丰富' },
                    negative: { type: 'string', description: '反向负面提示词，畸形、水印、低画质等' },
                    pose_file: { type: 'string', description: '（可选）姿势图库文件名。复杂双人动作必填：cowgirl_01.png=女上位跨坐、missionary_01~52.png=男上正面、oral_01~06.png=跪姿/口部特写、closeup_01~03.png=脸/上半身特写、from_behind_03~04.png=背后双人(双女慎用)、throne_pose.jpg=王座式、lift_pose.jpg=仰卧托举、backbend_lift.jpg=站立托举后仰、ballroom_dance.jpg=交谊舞牵手、piggyback.jpg=背背。选最接近用户动作的一张' },
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
        let positive = a.positive || '';
        let negative = a.negative || '';
        const poseFile = (a.pose_file || '').trim();

        // ---- 单人强制（防多出人，智能判定）----
        // 仅当：有人物指示 + 无 pose_file + 无双人/多人意图 + 非纯环境空镜 时，
        // 才注入单人限定与多人负面排除。避免“一个美女”被画出多人，
        // 同时不误伤双人/多人/环境/空镜场景；注入词按人物性别自动匹配。
        if (!poseFile) {
            const PAIR_HINTS = ['2girls', 'two girls', 'two women', 'two people', 'two persons', 'couple', 'pair', 'double', 'both', 'dual', 'twin', 'girl and a boy', 'boy and a girl', 'man and a woman', 'woman and a man', 'hugging', 'kissing', 'embrace', 'cuddling', 'holding hands', 'dancing together', '双人', '两人', '一对', '二人', '拥抱', '亲吻', '牵手', '依偎', '共舞'];
            const MULTI_HINTS = ['three people', 'three women', 'three men', 'group of', 'crowd', 'several people', 'many people', 'multiple people', 'audience', 'team', 'gang', 'battle', '多人', '人群', '群像', '一群', '军队', '战斗'];
            const hay = (positive + ' ' + negative).toLowerCase();
            const hasPerson = /(woman|girl|man|boy|person|people|figure|character|hero|heroine|warrior|nun|soldier|美女|女子|男子|人物|角色|战士)/i.test(positive);
            const isPair = PAIR_HINTS.some((k) => hay.includes(k));
            const isMulti = MULTI_HINTS.some((k) => hay.includes(k));
            if (hasPerson && !isPair && !isMulti) {
                if (!/(^|[,\s])(solo|single person|only one|alone)([,\s]|$)/i.test(positive)) {
                    let singleTag;
                    if (/(^|[,\s])(man|boy|male|guy|gentleman|soldier)([,\s]|$)/i.test(positive)) {
                        singleTag = '1man, solo, single person, only one man';
                    } else if (/(^|[,\s])(woman|girl|female|lady|heroine|nun)([,\s]|$)/i.test(positive)) {
                        singleTag = '1girl, solo, single person, only one woman';
                    } else {
                        singleTag = 'solo, single person, only one person';
                    }
                    positive = singleTag + ', ' + positive;
                }
                const extraNeg = 'two people, multiple people, extra person, group of people';
                negative = negative ? negative + ', ' + extraNeg : extraNeg;
            }
        }

        // ---- 默认风格注入 ----
        // 默认写实增强（realistic_enhance=true，越接近真实越好）；开启 comic_style 时改为漫画渲染。
        // 用户显式指定其他风格（anime/manga/cartoon/油画/水彩等）时不重复注入。
        if (settings.comic_style) {
            const STYLE_OVERRIDE = ['anime', 'manga', 'cartoon', '3d render', 'oil painting', 'watercolor', 'photorealistic', 'realistic photo'];
            const styleHay = (positive + ' ' + negative).toLowerCase();
            const hasStyle = STYLE_OVERRIDE.some((k) => styleHay.includes(k));
            if (!hasStyle) {
                positive = 'realistic comic book illustration, graphic novel style, clean inked linework, halftone shading, cinematic lighting, detailed face, ' + positive;
            }
        } else if (settings.realistic_enhance) {
            const STYLE_OVERRIDE = ['anime', 'manga', 'cartoon', '3d render', 'oil painting', 'watercolor'];
            const styleHay = (positive + ' ' + negative).toLowerCase();
            const hasStyle = STYLE_OVERRIDE.some((k) => styleHay.includes(k));
            if (!hasStyle) {
                positive = 'photorealistic, ultra detailed, 8k uhd, sharp focus, natural skin texture, realistic lighting, high quality, ' + positive;
            }
        }

        // ---- 期望人数推断（供质量审查用）----
        // 0=空镜(应无人) 1=单人 2=双人 -1=多人/姿势锁定(不锁人数，只查肢体/脸完整)
        function inferExpectedPeople() {
            if (poseFile) return -1;
            const hay2 = (positive + ' ' + negative).toLowerCase();
            const PAIR_HINTS2 = ['2girls', 'two girls', 'two women', 'two people', 'two persons', 'couple', 'pair', 'double', 'both', 'dual', 'twin', 'girl and a boy', 'boy and a girl', 'man and a woman', 'woman and a man', 'hugging', 'kissing', 'embrace', 'cuddling', 'holding hands', 'dancing together', '双人', '两人', '一对', '二人', '拥抱', '亲吻', '牵手', '依偎', '共舞'];
            const MULTI_HINTS2 = ['three people', 'three women', 'three men', 'group of', 'crowd', 'several people', 'many people', 'multiple people', 'audience', 'team', 'gang', 'battle', '多人', '人群', '群像', '一群', '军队', '战斗'];
            const hasPerson2 = /(woman|girl|man|boy|person|people|figure|character|hero|heroine|warrior|nun|soldier|美女|女子|男子|人物|角色|战士)/i.test(positive);
            if (MULTI_HINTS2.some((k) => hay2.includes(k))) return -1;
            if (PAIR_HINTS2.some((k) => hay2.includes(k))) return 2;
            if (hasPerson2) return 1;
            return 0;
        }

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

        // 姿势锁定：从图库加载姿势图 → OpenPose 提取骨骼 → ControlNet 锁姿势
        if (settings.pose_enabled && poseFile) {
            workflow['20'] = {
                class_type: 'LoadImage',
                inputs: { image: settings.pose_library_dir + '/' + poseFile },
            };
            workflow['21'] = {
                class_type: 'OpenposePreprocessor',
                inputs: {
                    image: ['20', 0],
                    detect_hand: 'enable',
                    detect_body: 'enable',
                    detect_face: 'disable',
                    resolution: 512,
                },
            };
            workflow['22'] = {
                class_type: 'ControlNetLoader',
                inputs: { control_net_name: settings.pose_controlnet },
            };
            workflow['23'] = {
                class_type: 'ControlNetApply',
                inputs: {
                    conditioning: ['6', 0],
                    control_net: ['22', 0],
                    image: ['21', 0],
                    strength: settings.pose_strength,
                },
            };
            workflow['3'].inputs.positive = ['23', 0];
        }

        // ---- 质量审查（QualityGate）：出图后自动检测畸形/人数，供重试决策 ----
        // 服务端需安装 quality_gate 自定义节点（含 QualityGate 节点）；未安装时提交会失败，
        // actionGenerateImage 会捕获并降级为不带审查的纯出图。
        if (settings.quality_gate) {
            workflow['30'] = {
                class_type: 'QualityGate',
                inputs: {
                    image: ['8', 0],
                    expected_people: inferExpectedPeople(),
                    min_body_kp: 10,
                    min_face_kp: 30,
                },
            };
            workflow['31'] = {
                class_type: 'SaveText',
                inputs: {
                    text: ['30', 5],
                    filename_prefix: 'qg_' + Math.floor(Date.now() / 1000).toString(36),
                    format: 'txt',
                },
            };
        }

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

        // ---- 质量审查重试循环：出图 → QualityGate 检测 → 不合格换 seed 重出 ----
        const maxAttempts = Math.max(1, settings.quality_retry || 3);
        const gateFailures = [];
        let lastResult = null;

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            // 1) 生成工作流（内部会保存 lastWorkflowJson）；第 2 次起强制换新 seed
            let json = await actionBuildWorkflow(a);
            if (attempt > 1) {
                try {
                    const wf = JSON.parse(json);
                    if (wf && wf['3']) {
                        wf['3'].inputs.seed = Math.floor(Math.random() * 1000000000000000);
                        json = JSON.stringify(wf);
                        lastWorkflowJson = json;
                    }
                } catch (e) { /* 保持原工作流 */ }
            }
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
                // 服务端无 QualityGate 节点导致提交失败 → 降级为纯出图（去掉审查节点重试一次）
                if (settings.quality_gate && String(sub && sub.error).indexOf('QualityGate') !== -1) {
                    settings.quality_gate = false;
                    return actionGenerateImage(a);
                }
                return JSON.stringify({ error: '提交失败：' + (sub.error || submitRaw) });
            }

            // 3) 轮询出图（最长 150 秒，每 2 秒一次；含审查节点时 OpenPose 检测需额外时间）
            let res = null;
            for (let i = 0; i < 75; i++) {
                await sleep(2000);
                try {
                    res = JSON.parse(await actionCheckProgress({ prompt_id: pid }));
                } catch (e) {
                    continue;
                }
                if (res.status === 'done' || res.status === 'error') break;
            }
            if (!res) {
                return JSON.stringify({ status: 'timeout', prompt_id: pid, message: '轮询超时（150秒），可调用 comfy_check_progress 继续查询' });
            }
            if (res.status === 'error') {
                return JSON.stringify(res);
            }

            lastResult = res;

            // 4) 质量审查：从 history 读 SaveText 的 summary（PASS / FAIL|...）
            const summary = await fetchQualitySummary(pid);
            if (summary === null) {
                // 服务端无审查节点（降级路径）：直接交付
                return JSON.stringify(res);
            }
            if (String(summary).startsWith('PASS')) {
                res.quality_gate = String(summary);
                res.quality_attempts = attempt;
                return JSON.stringify(res);
            }
            // FAIL：优先尝试局部重绘（mask 定位到问题区域）；无 mask 或重绘失败 → 换 seed 整图重试
            gateFailures.push(String(summary));
            const maskMatch = String(summary).match(/mask=(masks\/[^|]+)/);
            if (maskMatch && res.images && res.images.length && settings.quality_inpaint !== false) {
                const repaired = await tryInpaintRepair(res.images[0].url, maskMatch[1], a);
                if (repaired && repaired.quality_gate && String(repaired.quality_gate).startsWith('PASS')) {
                    repaired.quality_attempts = attempt;
                    repaired.quality_repair = true;
                    repaired.quality_gate_history = gateFailures.join(' || ');
                    return JSON.stringify(repaired);
                }
                if (repaired && repaired.error) {
                    gateFailures.push('inpaint:' + String(repaired.error).slice(0, 120));
                }
            }
            if (attempt < maxAttempts) {
                continue;
            }
        }

        // 5) 全部尝试均未通过审查：交付最后一次结果并附警告
        if (lastResult) {
            lastResult.quality_gate = 'FAIL after ' + maxAttempts + ' attempts: ' + gateFailures.join(' || ');
            lastResult.quality_attempts = maxAttempts;
            return JSON.stringify(lastResult);
        }
        return JSON.stringify({ status: 'error', message: '出图失败且无可交付结果' });
    }

    // 从任务 history 读取 SaveText 节点输出的审查 summary
    async function fetchQualitySummary(pid) {
        if (!settings.comfy_endpoint || !pid) return null;
        const base = settings.comfy_endpoint.replace(/\/+$/, '');
        try {
            const resp = await fetch(base + '/history/' + encodeURIComponent(pid));
            const history = await resp.json();
            const entry = history && history[pid];
            if (!entry) return null;
            const outputs = entry.outputs || {};
            for (const nodeId of Object.keys(outputs)) {
                const out = outputs[nodeId];
                if (out && Array.isArray(out.text) && out.text.length) {
                    return String(out.text[0]);
                }
            }
            return null;
        } catch (e) {
            return null;
        }
    }

    // 局部重绘：把出图下载后上传到 Comfy input，用 mask 做 inpaint，复审 PASS 即交付
    async function tryInpaintRepair(imageUrl, maskFile, args) {
        const base = settings.comfy_endpoint.replace(/\/+$/, '');
        try {
            // 1) 下载出图 → 上传到 Comfy input（/upload/image 需开启 CORS）
            const imgResp = await fetch(imageUrl);
            const imgBlob = await imgResp.blob();
            const srcName = 'qg_repair_' + Date.now() + '.png';
            const fd = new FormData();
            fd.append('image', imgBlob, srcName);
            const upResp = await fetch(base + '/upload/image?overwrite=true', { method: 'POST', body: fd });
            const upJson = await upResp.json();
            const uploadedName = (upJson && upJson.name) || srcName;

            // 2) 构造 inpaint 工作流：原图 + mask → VAEEncodeForInpaint → KSampler(denoise 0.6) → 复审
            const positive = args.positive || '';
            const negative = args.negative || '';
            const wf = {
                '1': { class_type: 'LoadImage', inputs: { image: uploadedName } },
                '2': { class_type: 'LoadImage', inputs: { image: maskFile } },
                '2b': { class_type: 'ImageToMask', inputs: { image: ['2', 0], channel: 'red' } },
                '3': { class_type: 'VAEEncodeForInpaint', inputs: { pixels: ['1', 0], vae: ['4', 2], mask: ['2b', 0], grow_mask_by: 6 } },
                '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: settings.checkpoint } },
                '5': { class_type: 'KSampler', inputs: {
                    seed: Math.floor(Math.random() * 1000000000000000),
                    steps: Math.max(20, parseInt(settings.steps, 10) || 30),
                    cfg: parseFloat(settings.cfg) || 6,
                    sampler_name: settings.sampler_name || 'dpmpp_2m',
                    scheduler: settings.scheduler || 'karras',
                    denoise: 0.6,
                    model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['3', 0],
                } },
                '6': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 1] } },
                '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
                '8': { class_type: 'VAEDecode', inputs: { samples: ['5', 0], vae: ['4', 2] } },
                '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'qg_inpaint', images: ['8', 0] } },
            };
            if (settings.quality_gate) {
                wf['30'] = { class_type: 'QualityGate', inputs: { image: ['8', 0], expected_people: inferExpectedPeople(args), min_body_kp: 10, min_face_kp: 30 } };
                wf['31'] = { class_type: 'SaveText', inputs: { text: ['30', 5], filename_prefix: 'qg_inpaint', format: 'txt' } };
            }

            // 3) 提交
            const body = { prompt: wf, client_id: 'comfydroid-inpaint' };
            const subResp = await fetch(base + '/prompt', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            const sub = await subResp.json();
            if (!sub || !sub.prompt_id) {
                return { error: (sub && sub.error) || '重绘提交失败' };
            }
            const pid = sub.prompt_id;

            // 4) 轮询
            let done = null;
            for (let i = 0; i < 75; i++) {
                await sleep(2000);
                try {
                    const hist = await (await fetch(base + '/history/' + encodeURIComponent(pid))).json();
                    const entry = hist && hist[pid];
                    if (!entry) continue;
                    if (entry.status && entry.status.status_str === 'error') {
                        return { error: '重绘执行出错' };
                    }
                    if (entry.status && entry.status.completed > 0) {
                        const images = [];
                        let summary = null;
                        const outputs = entry.outputs || {};
                        for (const nodeId of Object.keys(outputs)) {
                            const out = outputs[nodeId];
                            if (out && Array.isArray(out.images)) {
                                for (const img of out.images) {
                                    images.push({
                                        url: base + '/view?filename=' + encodeURIComponent(img.filename)
                                            + '&subfolder=' + encodeURIComponent(img.subfolder || '')
                                            + '&type=' + encodeURIComponent(img.type || 'output'),
                                        filename: img.filename,
                                    });
                                }
                            }
                            if (out && Array.isArray(out.text) && out.text.length) summary = String(out.text[0]);
                        }
                        done = { status: 'done', images: images, image_url: images[0] && images[0].url, quality_gate: summary };
                        break;
                    }
                } catch (e) { /* 继续轮询 */ }
            }
            if (!done) return { error: '重绘轮询超时' };
            if (done.image_url) done.markdown = '![image](' + done.image_url + ')';
            return done;
        } catch (e) {
            return { error: '局部重绘失败：' + e.message };
        }
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
    // 消息注入：压制预设/角色对绘图工具的干扰
    // 在发往 LLM 的用户消息后附加一句强制提示，确保任何预设下都会调用绘图工具
    // ------------------------------------------------------------------
    const DRAW_KEYWORDS = /画|绘|图|生成图|壁纸|封面|海报|头像|插画|image|draw|picture|avatar/i;
    const INJECT_TEXT = '\n\n[系统] 你已接入 Comfy 绘图工具链（工具：comfy_generate_image）。本条消息疑似要求生成图片：请调用 comfy_generate_image 直接出图，按你的角色风格撰写英文正向提示词；除非用户明确要求写故事，否则不要把它当作写作任务，不要用文字描述代替出图。工具返回图片链接后，必须在最终回复中用 ![image](图片链接) 把图片展示出来，绝对禁止回复“没有新画面，未出图”等不含图片链接的文字。';

    function injectDrawingHint(msgText) {
        if (!settings.inject_prompt) return msgText;
        if (!msgText || !DRAW_KEYWORDS.test(msgText)) return msgText;
        return msgText + INJECT_TEXT;
    }

    function setupMessageInjection() {
        const ctx = SillyTavern.getContext();
        if (typeof ctx.setMessageFormatting !== 'function') {
            console.warn('[ComfyDroid] 当前环境不支持 setMessageFormatting，消息注入不可用');
            return;
        }
        try {
            ctx.setMessageFormatting((chat, msgText, isUser) => {
                if (!isUser) return msgText;
                return injectDrawingHint(msgText);
            });
            console.log('[ComfyDroid] 消息注入已启用（绘图关键词触发）');
        } catch (e) {
            console.error('[ComfyDroid] 消息注入设置失败：', e);
        }
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
              <label class="checkbox_label" for="cd_inject">
                <input type="checkbox" id="cd_inject"> 自动注入绘图提示（压制预设干扰，推荐开启）
              </label>
              <label class="checkbox_label" for="cd_quality_gate">
                <input type="checkbox" id="cd_quality_gate"> 质量审查（出图后自动检测畸形，不合格换 seed 重试，推荐开启）
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
        const injectEl = document.getElementById('cd_inject');
        if (injectEl) injectEl.checked = !!settings.inject_prompt;
        const qualityGateEl = document.getElementById('cd_quality_gate');
        if (qualityGateEl) qualityGateEl.checked = !!settings.quality_gate;

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
        if (injectEl) {
            injectEl.addEventListener('change', () => {
                settings.inject_prompt = injectEl.checked;
                saveSettingsDebounced();
            });
        }
        if (qualityGateEl) {
            qualityGateEl.addEventListener('change', () => {
                settings.quality_gate = qualityGateEl.checked;
                saveSettingsDebounced();
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

        // 消息注入（压制预设干扰，强制绘图工具可用）
        setupMessageInjection();

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
