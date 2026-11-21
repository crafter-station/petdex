import type { Locale } from "@/i18n/config";

export const CODING_AGENT_SLUGS = [
  "claude-code",
  "codex",
  "gemini-cli",
  "opencode",
  "hermes",
  "kimi-code",
  "qoder",
  "codebuddy",
  "omp",
  "dsh",
] as const;

export type CodingAgentSlug = (typeof CODING_AGENT_SLUGS)[number];

export type CodingAgentFaq = {
  q: string;
  a: string;
};

export type CodingAgentLocaleCopy = {
  title: string;
  subtitle: string;
  howItWorks: string;
  faqs: readonly CodingAgentFaq[];
};

export type CodingAgent = {
  slug: CodingAgentSlug;
  name: string;
  vendor: string;
  icon: string;
  installCommand: string;
  hookMechanism: string;
  copy: Record<Locale, CodingAgentLocaleCopy>;
};

export const DEFAULT_INSTALL_COMMAND = "npx petdex install boba";
export const FALLBACK_AGENT_ICON = "/brand/petdex-mark.svg";

export const CODING_AGENTS: readonly CodingAgent[] = [
  {
    slug: "claude-code",
    name: "Claude Code",
    vendor: "Anthropic",
    icon: "/brand/agents/claude-code.svg",
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "JSON lifecycle hooks merged into ~/.claude/settings.json (or CLAUDE_CONFIG_DIR) plus local read-only transcript recovery.",
    copy: {
      en: {
        title: "Animated Pixel Pets for Claude Code",
        subtitle:
          "Pair Claude Code with a floating Petdex companion that reacts to every tool call, edit, and build on macOS, Windows, and Linux.",
        howItWorks:
          "Petdex Desktop detects your Claude Code installation under ~/.claude or CLAUDE_CONFIG_DIR and merges non-destructive lifecycle hooks into settings.json with a one-time backup. Whenever Claude Code thinks, runs bash, edits files, hits a tool failure, or finishes a turn, your pixel pet animates in real time across nine states, backed by read-only transcript recovery.",
        faqs: [
          {
            q: "How do I connect Petdex to Claude Code?",
            a: "Install a pet with npx petdex install boba, launch Petdex Desktop, open Settings with Cmd+, and click Connect next to Claude Code under Agents.",
          },
          {
            q: "Does Petdex overwrite my existing Claude Code hooks?",
            a: "No. Petdex merges only its own hook entries into settings.json, leaves non-Petdex hooks untouched, and writes a backup beside the config file.",
          },
          {
            q: "Does Petdex support custom CLAUDE_CONFIG_DIR profiles?",
            a: "Yes. Petdex reads CLAUDE_CONFIG_DIR and also supports setting claude_config_dir inside ~/.petdex/agent-paths.json for isolated profiles.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para Claude Code",
        subtitle:
          "Combina Claude Code con una mascota flotante de Petdex que reacciona a cada llamada de herramienta, edicion y compilacion en macOS, Windows y Linux.",
        howItWorks:
          "Petdex Desktop detecta tu instalacion de Claude Code en ~/.claude o CLAUDE_CONFIG_DIR y fusiona hooks de ciclo de vida en settings.json con copia de seguridad automatica. Cada vez que Claude Code piensa, ejecuta comandos, edita archivos o termina una tarea, tu mascota pixel reacciona en tiempo real con recuperacion de sesiones de solo lectura.",
        faqs: [
          {
            q: "Como conecto Petdex con Claude Code?",
            a: "Instala una mascota con npx petdex install boba, abre Petdex Desktop, pulsa Cmd+, para entrar en Ajustes y haz clic en Conectar junto a Claude Code en Agents.",
          },
          {
            q: "Petdex sobrescribe mis hooks existentes de Claude Code?",
            a: "No. Petdex solo fusiona sus propias entradas en settings.json, mantiene intactos tus otros hooks y guarda un respaldo junto al archivo.",
          },
          {
            q: "Funciona con perfiles personalizados de CLAUDE_CONFIG_DIR?",
            a: "Si. Petdex respeta CLAUDE_CONFIG_DIR y tambien permite definir claude_config_dir en ~/.petdex/agent-paths.json.",
          },
        ],
      },
      zh: {
        title: "适用于 Claude Code 的动态像素宠物",
        subtitle:
          "为 Claude Code 配上一只悬浮在桌面上的 Petdex 像素伙伴，在 macOS、Windows 和 Linux 上实时响应每一次工具调用与代码编辑。",
        howItWorks:
          "Petdex Desktop 会自动检测 ~/.claude 或 CLAUDE_CONFIG_DIR 中的 Claude Code 配置，并以无损方式将生命周期 Hook 合并进 settings.json，同时保留一次备份。当 Claude Code 思考、执行命令、修改文件或完成任务时，像素宠物会在九种状态间实时切换，并支持只读会话恢复。",
        faqs: [
          {
            q: "如何将 Petdex 连接到 Claude Code？",
            a: "先运行 npx petdex install boba 安装宠物，打开 Petdex Desktop，按 Cmd+, 进入设置，在 Agents 中点击 Claude Code 旁的连接按钮即可。",
          },
          {
            q: "Petdex 会覆盖我原有的 Claude Code Hooks 吗？",
            a: "不会。Petdex 只合并自身的 Hook 条目，保留所有第三方配置，并在修改前生成备份文件。",
          },
          {
            q: "是否支持自定义 CLAUDE_CONFIG_DIR？",
            a: "支持。Petdex 会读取 CLAUDE_CONFIG_DIR，也支持在 ~/.petdex/agent-paths.json 中指定 claude_config_dir。",
          },
        ],
      },
    },
  },
  {
    slug: "codex",
    name: "OpenAI Codex",
    vendor: "OpenAI",
    icon: "/brand/agents/codex.svg",
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "Native Codex pet packs under ~/.codex/pets plus Petdex Desktop hook runner and durable Codex rollout recovery.",
    copy: {
      en: {
        title: "Animated Pixel Pets for OpenAI Codex",
        subtitle:
          "Browse, install, and float community pixel pets built natively for the Codex sprite format and Petdex Desktop.",
        howItWorks:
          "Petdex was created for the Codex pet format: every pet pack ships with pet.json and a spritesheet ready for ~/.petdex/pets and ~/.codex/pets. Petdex Desktop connects to OpenAI Codex through its in-binary hook runner and durable rollout recovery, keeping your mascot synchronized across terminal and desktop sessions.",
        faqs: [
          {
            q: "How do I install a Petdex pet for OpenAI Codex?",
            a: "Run npx petdex install boba in your terminal to download the pet pack, then select it in Petdex Desktop or inside your Codex companion settings.",
          },
          {
            q: "Can I create my own pixel pet for Codex?",
            a: "Yes. Every pet is a standard folder with pet.json and an 8x9 or v2 8x11 spritesheet of 192x208 frames. You can submit it with npx petdex submit.",
          },
          {
            q: "Does Petdex Desktop recover active Codex sessions after restart?",
            a: "Yes. Alongside low-latency hooks, Petdex Desktop performs local read-only recovery against Codex rollouts.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para OpenAI Codex",
        subtitle:
          "Explora, instala y flota mascotas pixel de la comunidad creadas de forma nativa para el formato de sprites de Codex y Petdex Desktop.",
        howItWorks:
          "Petdex nacio para el formato de mascotas de Codex: cada paquete incluye pet.json y un spritesheet listo para ~/.petdex/pets y ~/.codex/pets. Petdex Desktop se conecta a OpenAI Codex mediante su ejecutor de hooks nativo y recuperacion de sesiones por rollouts.",
        faqs: [
          {
            q: "Como instalo una mascota de Petdex para OpenAI Codex?",
            a: "Ejecuta npx petdex install boba en tu terminal para descargar el paquete y luego seleccionala en Petdex Desktop o en tu configuracion de Codex.",
          },
          {
            q: "Puedo crear mi propia mascota pixel para Codex?",
            a: "Si. Cada mascota es una carpeta con pet.json y un spritesheet de 8x9 o 8x11 cuadros de 192x208, y puedes publicarla con npx petdex submit.",
          },
          {
            q: "Petdex Desktop recupera sesiones activas de Codex?",
            a: "Si. Ademas de los hooks de baja latencia, Petdex Desktop realiza recuperacion local de solo lectura con los rollouts de Codex.",
          },
        ],
      },
      zh: {
        title: "适用于 OpenAI Codex 的动态像素宠物",
        subtitle:
          "一键安装原生兼容 Codex 精灵格式的社区像素宠物，并在 Petdex Desktop 中实时悬浮陪伴。",
        howItWorks:
          "Petdex 原生适配 Codex 宠物格式：每个宠物包都包含 pet.json 和精灵图，可直接用于 ~/.petdex/pets 与 ~/.codex/pets。Petdex Desktop 通过内置 Hook 运行器与只读 rollout 恢复机制，让宠物与你的 Codex 会话保持同步。",
        faqs: [
          {
            q: "如何为 OpenAI Codex 安装 Petdex 宠物？",
            a: "在终端运行 npx petdex install boba 即可下载宠物包，随后在 Petdex Desktop 或 Codex 设置中启用。",
          },
          {
            q: "我可以制作并提交自己的 Codex 宠物吗？",
            a: "可以。每个宠物包由 pet.json 和 8x9 或 v2 8x11 的 192x208 精灵图组成，使用 npx petdex submit 即可提交到公共图鉴。",
          },
          {
            q: "重启后 Petdex Desktop 能恢复 Codex 会话状态吗？",
            a: "可以。除了低延迟 Hook 之外，Petdex Desktop 还支持基于本地 Codex rollouts 的只读会话恢复。",
          },
        ],
      },
    },
  },
  {
    slug: "gemini-cli",
    name: "Gemini CLI",
    vendor: "Google",
    icon: "/brand/agents/gemini.svg",
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "JSON lifecycle hooks in ~/.gemini/settings.json plus local read-only Gemini chat session recovery.",
    copy: {
      en: {
        title: "Animated Pixel Pets for Gemini CLI",
        subtitle:
          "Give Google Gemini CLI a reactive desktop pixel mascot that celebrates successful runs and alerts you when tools fail.",
        howItWorks:
          "Petdex Desktop detects Gemini CLI automatically and installs its canonical hook entries into ~/.gemini/settings.json without touching your existing configuration. It also watches local Gemini chat artifacts for read-only session recovery so your companion stays accurate across long sessions.",
        faqs: [
          {
            q: "How does Petdex connect to Gemini CLI?",
            a: "Run npx petdex install boba, open Petdex Desktop, press Cmd+, and enable Gemini CLI in one click under Agents.",
          },
          {
            q: "Which operating systems work with Gemini CLI and Petdex?",
            a: "Petdex Desktop runs natively on macOS, Windows, and Linux without a WebView or Node sidecar.",
          },
          {
            q: "Does Petdex send my Gemini CLI prompts to the cloud?",
            a: "No. Agent hooks and durable recovery run strictly locally on your machine to drive the pet's animation state.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para Gemini CLI",
        subtitle:
          "Agrega a Google Gemini CLI una mascota pixel de escritorio que celebra tus ejecuciones exitosas y te avisa cuando una herramienta falla.",
        howItWorks:
          "Petdex Desktop detecta Gemini CLI automaticamente e instala sus entradas de hooks en ~/.gemini/settings.json sin alterar el resto de tu configuracion. Tambien ofrece recuperacion local de solo lectura sobre chats de Gemini.",
        faqs: [
          {
            q: "Como conecto Petdex con Gemini CLI?",
            a: "Ejecuta npx petdex install boba, abre Petdex Desktop, presiona Cmd+, y activa Gemini CLI con un clic en Agents.",
          },
          {
            q: "En que sistemas operativos funciona?",
            a: "Petdex Desktop corre de forma nativa en macOS, Windows y Linux sin WebView ni procesos de Node en segundo plano.",
          },
          {
            q: "Petdex sube mis prompts de Gemini CLI a la nube?",
            a: "No. Los hooks y la recuperacion de sesiones ocurren localmente en tu equipo solo para animar a la mascota.",
          },
        ],
      },
      zh: {
        title: "适用于 Gemini CLI 的动态像素宠物",
        subtitle:
          "为 Google Gemini CLI 配上一只桌面像素伙伴，实时呈现思考、工具调用、成功完成与异常提醒。",
        howItWorks:
          "Petdex Desktop 会自动发现本机安装的 Gemini CLI，并将标准 Hook 写入 ~/.gemini/settings.json，不破坏任何已有配置，同时提供基于本地 Gemini 对话记录的只读会话恢复。",
        faqs: [
          {
            q: "如何将 Petdex 与 Gemini CLI 绑定？",
            a: "运行 npx petdex install boba 安装宠物后，打开 Petdex Desktop，按 Cmd+, 在 Agents 中一键启用 Gemini CLI。",
          },
          {
            q: "支持哪些操作系统？",
            a: "Petdex Desktop 原生支持 macOS、Windows 和 Linux，不依赖 WebView 或 Node 常驻进程。",
          },
          {
            q: "Petdex 会上传我的 Gemini CLI 对话内容吗？",
            a: "不会。所有 Hook 与会话状态检测均在本地完成，仅用于驱动宠物动画状态。",
          },
        ],
      },
    },
  },
  {
    slug: "opencode",
    name: "OpenCode",
    vendor: "SST / OpenCode",
    icon: "/brand/agents/opencode.svg",
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "Low-latency OpenCode lifecycle hook integration managed directly from Petdex Desktop Settings.",
    copy: {
      en: {
        title: "Animated Pixel Pets for OpenCode",
        subtitle:
          "Float an open-source pixel companion above your OpenCode terminal sessions with zero manual config editing.",
        howItWorks:
          "Petdex Desktop detects your OpenCode installation and registers its lightweight local hook bridge with one click in Settings. Every tool execution, waiting prompt, and completed run immediately drives your chosen Petdex mascot.",
        faqs: [
          {
            q: "How do I enable Petdex for OpenCode?",
            a: "Install a pet via npx petdex install boba, launch Petdex Desktop, open Settings with Cmd+,, and click Connect next to opencode.",
          },
          {
            q: "Can I use Petdex with both OpenCode and Claude Code at the same time?",
            a: "Yes. Petdex Desktop listens to all connected coding agents simultaneously and reacts to whichever agent is active.",
          },
          {
            q: "Can I remove the OpenCode hook later?",
            a: "Yes. Open Petdex Desktop Settings and click Remove next to opencode to cleanly uninstall only Petdex's hook entries.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para OpenCode",
        subtitle:
          "Flota una mascota pixel open-source sobre tus sesiones de OpenCode sin editar configuraciones a mano.",
        howItWorks:
          "Petdex Desktop detecta tu instalacion de OpenCode y registra su puente local de hooks con un clic desde Ajustes. Cada ejecucion de herramienta, espera de entrada o tarea completada anima al instante a tu mascota.",
        faqs: [
          {
            q: "Como activo Petdex para OpenCode?",
            a: "Instala una mascota con npx petdex install boba, abre Petdex Desktop, entra a Ajustes con Cmd+, y haz clic en Conectar junto a opencode.",
          },
          {
            q: "Puedo usar Petdex con OpenCode y otros agentes a la vez?",
            a: "Si. Petdex Desktop escucha todos los agentes conectados al mismo tiempo y reacciona al que este trabajando.",
          },
          {
            q: "Puedo quitar el hook de OpenCode despues?",
            a: "Si. Desde Ajustes en Petdex Desktop puedes eliminar unicamente las entradas de Petdex con un clic.",
          },
        ],
      },
      zh: {
        title: "适用于 OpenCode 的动态像素宠物",
        subtitle:
          "无需手写配置文件，即可让开源像素宠物悬浮在你的 OpenCode 终端工作区上方。",
        howItWorks:
          "Petdex Desktop 会自动检测 OpenCode 安装并在设置中一键注册本地 Hook 桥接。每次工具调用、等待确认或任务完成都会即时反映到宠物动画中。",
        faqs: [
          {
            q: "如何为 OpenCode 启用 Petdex？",
            a: "运行 npx petdex install boba 安装宠物，打开 Petdex Desktop，按 Cmd+, 进入设置并点击 opencode 旁的连接按钮。",
          },
          {
            q: "可以同时连接 OpenCode 和其他编码代理吗？",
            a: "可以。Petdex Desktop 支持同时监听多个已连接的编码代理，实时响应当前活跃会话。",
          },
          {
            q: "之后如何卸载 OpenCode 的 Hook？",
            a: "在 Petdex Desktop 设置中点击移除即可安全清理 Petdex 写入的 Hook 条目。",
          },
        ],
      },
    },
  },
  {
    slug: "hermes",
    name: "Hermes",
    vendor: "Nous Research",
    icon: FALLBACK_AGENT_ICON,
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "Hermes plugin under ~/.hermes/plugins/petdex-desktop, shell-hooks allowlist registration, and local state.db session recovery.",
    copy: {
      en: {
        title: "Animated Pixel Pets for Hermes Agent",
        subtitle:
          "Connect Nous Research's Hermes agent to Petdex Desktop for real-time pixel animations and durable state.db recovery.",
        howItWorks:
          "Petdex Desktop installs the petdex-desktop plugin into ~/.hermes/plugins/petdex-desktop (or your HERMES_HOME directory) and updates ~/.hermes/shell-hooks-allowlist.json automatically. On POSIX systems, it pairs low-latency hooks with local read-only recovery over Hermes state.db.",
        faqs: [
          {
            q: "How does Petdex integrate with Hermes?",
            a: "Petdex Desktop writes its bundled petdex-desktop plugin and allowlist entry under ~/.hermes (or HERMES_HOME) when you click Connect in Settings.",
          },
          {
            q: "Does Petdex support custom HERMES_HOME paths?",
            a: "Yes. Petdex reads HERMES_HOME automatically and also lets you configure agents.hermes.home for remote or custom installs.",
          },
          {
            q: "Does Hermes already use Petdex pet packs?",
            a: "Yes. NousResearch/hermes-agent is featured on Petdex Built With and integrates directly with Petdex manifests and hooks.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para Hermes Agent",
        subtitle:
          "Conecta Hermes de Nous Research con Petdex Desktop para animaciones pixel en tiempo real y recuperacion local con state.db.",
        howItWorks:
          "Petdex Desktop instala el plugin petdex-desktop en ~/.hermes/plugins/petdex-desktop (o en tu directorio HERMES_HOME) y registra el permiso en ~/.hermes/shell-hooks-allowlist.json automaticamente, combinando hooks rapidos con recuperacion de solo lectura sobre state.db.",
        faqs: [
          {
            q: "Como se integra Petdex con Hermes?",
            a: "Al hacer clic en Conectar en Ajustes, Petdex Desktop instala el plugin petdex-desktop y su entrada en shell-hooks-allowlist.json dentro de ~/.hermes.",
          },
          {
            q: "Soporta rutas personalizadas de HERMES_HOME?",
            a: "Si. Petdex detecta HERMES_HOME automaticamente y tambien permite configurar agents.hermes.home.",
          },
          {
            q: "Hermes forma parte del ecosistema Built With Petdex?",
            a: "Si. NousResearch/hermes-agent aparece en la galeria Built With de Petdex y soporta manifiestos y hooks de Petdex.",
          },
        ],
      },
      zh: {
        title: "适用于 Hermes Agent 的动态像素宠物",
        subtitle:
          "将 Nous Research 的 Hermes 代理接入 Petdex Desktop，享受实时像素动画与基于 state.db 的本地会话恢复。",
        howItWorks:
          "Petdex Desktop 会自动在 ~/.hermes/plugins/petdex-desktop（或 HERMES_HOME）安装 petdex-desktop 插件并更新 ~/.hermes/shell-hooks-allowlist.json，同时结合 Hermes 本地 state.db 提供只读会话恢复。",
        faqs: [
          {
            q: "Petdex 如何与 Hermes 集成？",
            a: "在 Petdex Desktop 设置中点击连接后，应用会自动部署 petdex-desktop 插件并更新 ~/.hermes 下的 Hook 白名单。",
          },
          {
            q: "支持自定义 HERMES_HOME 目录吗？",
            a: "支持。Petdex 会自动读取 HERMES_HOME，也支持通过配置指定自定义路径。",
          },
          {
            q: "Hermes 是否原生兼容 Petdex 生态？",
            a: "是的。NousResearch/hermes-agent 已收录在 Petdex Built With 展示页，并支持 Petdex 宠物格式与桌面联动。",
          },
        ],
      },
    },
  },
  {
    slug: "kimi-code",
    name: "Kimi Code",
    vendor: "Moonshot AI",
    icon: "/brand/agents/kimi-code.svg",
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "JSON lifecycle hooks installed automatically by Petdex Desktop with one-click setup and clean removal.",
    copy: {
      en: {
        title: "Animated Pixel Pets for Kimi Code",
        subtitle:
          "Add a lively Petdex pixel mascot to Moonshot AI's Kimi Code sessions on macOS, Windows, and Linux.",
        howItWorks:
          "Petdex Desktop detects Kimi Code on your machine and registers its in-binary hook runner into Kimi Code's configuration. As Kimi Code plans, invokes tools, or finishes edits, your floating pet responds with matching pixel states and subtle status bubbles.",
        faqs: [
          {
            q: "How do I set up Petdex with Kimi Code?",
            a: "Install a pet with npx petdex install boba, open Petdex Desktop, press Cmd+,, and connect Kimi Code under Agents.",
          },
          {
            q: "Are Chinese-localized pets and UI supported?",
            a: "Yes. Petdex ships full Simplified Chinese (zh) support across petdex.dev and the Pocket Toy brand system (Petdex · 宠物图鉴).",
          },
          {
            q: "Is Petdex free and open source?",
            a: "Yes. Petdex is open source under MIT, created by Railly Hugo at Crafter Station.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para Kimi Code",
        subtitle:
          "Agrega una mascota pixel de Petdex a tus sesiones de Kimi Code de Moonshot AI en macOS, Windows y Linux.",
        howItWorks:
          "Petdex Desktop detecta Kimi Code en tu equipo y registra su ejecutor de hooks nativo en la configuracion de Kimi Code. Mientras Kimi Code planifica, usa herramientas o completa ediciones, tu mascota flotante responde con animaciones en vivo.",
        faqs: [
          {
            q: "Como configuro Petdex con Kimi Code?",
            a: "Instala una mascota con npx petdex install boba, abre Petdex Desktop, pulsa Cmd+, y conecta Kimi Code en Agents.",
          },
          {
            q: "Petdex soporta varios idiomas?",
            a: "Si. Petdex esta disponible en ingles, espanol y chino simplificado en toda la plataforma.",
          },
          {
            q: "Petdex es gratuito y de codigo abierto?",
            a: "Si. Petdex es un proyecto open source creado por Railly Hugo en Crafter Station.",
          },
        ],
      },
      zh: {
        title: "适用于 Kimi Code 的动态像素宠物",
        subtitle:
          "为月之暗面 Kimi Code 搭配 Petdex 桌面像素宠物，在 macOS、Windows 和 Linux 上实时互动。",
        howItWorks:
          "Petdex Desktop 会自动识别本机安装的 Kimi Code，并将内置 Hook 运行器写入配置。当 Kimi Code 规划任务、调用工具或完成修改时，桌面上的像素宠物会同步切换状态并展示气泡提示。",
        faqs: [
          {
            q: "如何为 Kimi Code 配置 Petdex？",
            a: "先运行 npx petdex install boba 下载宠物，打开 Petdex Desktop，按 Cmd+, 在 Agents 列表里一键连接 Kimi Code。",
          },
          {
            q: "Petdex 支持中文界面吗？",
            a: "支持。Petdex（宠物图鉴）提供完整的简体中文界面、文档与双语品牌体系。",
          },
          {
            q: "Petdex 是免费开源的吗？",
            a: "是的。Petdex 由 Crafter Station 的 Railly Hugo 创建并采用 MIT 协议开源。",
          },
        ],
      },
    },
  },
  {
    slug: "qoder",
    name: "Qoder",
    vendor: "Alibaba / Qoder",
    icon: "/brand/agents/qoder.svg",
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "JSON lifecycle hooks merged into both ~/.qoder/settings.json and ~/.qoder-cn/settings.json roots.",
    copy: {
      en: {
        title: "Animated Pixel Pets for Qoder",
        subtitle:
          "Float a pixel companion beside Qoder and Qoder CN with automatic dual-root hook detection.",
        howItWorks:
          "Petdex Desktop checks both global (~/.qoder) and China (~/.qoder-cn) Qoder configuration directories, plus custom Qoder environment overrides. One click in Settings merges Petdex lifecycle hooks into settings.json so your pet reacts to every tool run and error.",
        faqs: [
          {
            q: "Does Petdex support both Qoder and Qoder CN?",
            a: "Yes. Petdex Desktop inspects both ~/.qoder and ~/.qoder-cn roots automatically and keeps both configurations in sync.",
          },
          {
            q: "How do I install my first pet for Qoder?",
            a: "Run npx petdex install boba, open Petdex Desktop, press Cmd+,, pick Boba under Pets, and click Connect on Qoder.",
          },
          {
            q: "Does Petdex slow down Qoder?",
            a: "No. Petdex uses a lightweight native binary hook runner written in Zig with zero Node startup overhead.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para Qoder",
        subtitle:
          "Flota una mascota pixel junto a Qoder y Qoder CN con deteccion automatica de ambos directorios de configuracion.",
        howItWorks:
          "Petdex Desktop revisa tanto ~/.qoder como ~/.qoder-cn y sus variables de entorno. Con un clic en Ajustes fusiona los hooks de ciclo de vida en settings.json para que tu mascota reaccione a cada llamada y error de herramienta.",
        faqs: [
          {
            q: "Petdex soporta Qoder global y Qoder CN?",
            a: "Si. Petdex Desktop detecta automaticamente ~/.qoder y ~/.qoder-cn y mantiene ambas configuraciones al dia.",
          },
          {
            q: "Como instalo mi primera mascota para Qoder?",
            a: "Ejecuta npx petdex install boba, abre Petdex Desktop, pulsa Cmd+, elige Boba y haz clic en Conectar en Qoder.",
          },
          {
            q: "Afecta el rendimiento de Qoder?",
            a: "No. El ejecutor de hooks de Petdex es un binario nativo ligero sin sobrecarga de arranque de Node.",
          },
        ],
      },
      zh: {
        title: "适用于 Qoder 的动态像素宠物",
        subtitle:
          "自动识别 Qoder 与 Qoder CN 双配置目录，让可爱的像素伙伴全程陪伴你的编码过程。",
        howItWorks:
          "Petdex Desktop 会同时检测 ~/.qoder 与 ~/.qoder-cn 配置目录以及自定义环境变量。在设置中点击连接即可将生命周期 Hook 无损合并到 settings.json，实时响应工具执行与错误提示。",
        faqs: [
          {
            q: "Petdex 同时支持国际版 Qoder 和 Qoder CN 吗？",
            a: "支持。Petdex Desktop 会自动检测 ~/.qoder 与 ~/.qoder-cn 两个目录并同步安装 Hook。",
          },
          {
            q: "如何为 Qoder 安装第一只宠物？",
            a: "运行 npx petdex install boba，打开 Petdex Desktop，按 Cmd+, 在 Pets 中选择 Boba，并在 Agents 中连接 Qoder。",
          },
          {
            q: "会影响 Qoder 的运行速度吗？",
            a: "不会。Petdex 使用原生二进制 Hook 运行器，没有 Node 启动开销，响应极快。",
          },
        ],
      },
    },
  },
  {
    slug: "codebuddy",
    name: "CodeBuddy",
    vendor: "Tencent",
    icon: "/brand/agents/codebuddy.svg",
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "JSON lifecycle hooks installed via Petdex Desktop's in-binary hook runner with automatic config backup.",
    copy: {
      en: {
        title: "Animated Pixel Pets for CodeBuddy",
        subtitle:
          "Pair CodeBuddy with animated pixel pets from the open-source Petdex catalog in one command.",
        howItWorks:
          "Petdex Desktop discovers CodeBuddy locally and merges its canonical lifecycle hooks into CodeBuddy's settings without disturbing your custom entries. Your pet floats above your editor and animates across idle, working, happy, and alert states.",
        faqs: [
          {
            q: "How do I connect CodeBuddy to Petdex?",
            a: "Run npx petdex install boba, download and open Petdex Desktop, open Settings with Cmd+,, and click Connect next to CodeBuddy.",
          },
          {
            q: "Can I switch pets without reconnecting CodeBuddy?",
            a: "Yes. Agent hooks are independent of the active pet, so you can swap between hundreds of community pets anytime.",
          },
          {
            q: "Where are installed pets stored?",
            a: "The CLI stores downloaded pet packs in ~/.petdex/pets/<slug>/ containing pet.json and spritesheet.webp.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para CodeBuddy",
        subtitle:
          "Combina CodeBuddy con mascotas pixel animadas del catalogo open-source de Petdex con un solo comando.",
        howItWorks:
          "Petdex Desktop detecta CodeBuddy en tu maquina y fusiona sus hooks de ciclo de vida en la configuracion sin tocar tus entradas previas. Tu mascota flota sobre el editor y cambia entre estados de reposo, trabajo, alegria y alerta.",
        faqs: [
          {
            q: "Como conecto CodeBuddy con Petdex?",
            a: "Ejecuta npx petdex install boba, abre Petdex Desktop, pulsa Cmd+, y haz clic en Conectar junto a CodeBuddy.",
          },
          {
            q: "Puedo cambiar de mascota sin reconectar CodeBuddy?",
            a: "Si. Los hooks del agente son independientes de la mascota activa, asi que puedes cambiarla en cualquier momento.",
          },
          {
            q: "Donde se guardan las mascotas instaladas?",
            a: "La CLI guarda cada paquete en ~/.petdex/pets/<slug>/ con pet.json y spritesheet.webp.",
          },
        ],
      },
      zh: {
        title: "适用于 CodeBuddy 的动态像素宠物",
        subtitle:
          "一行命令为腾讯云 CodeBuddy 装上来自 Petdex 开源图鉴的动态像素宠物。",
        howItWorks:
          "Petdex Desktop 会自动检测本机 CodeBuddy 配置，并以无损合并方式安装标准生命周期 Hook。宠物会悬浮在编辑器上方，随任务进度在待机、工作、庆祝与提醒等状态间流畅切换。",
        faqs: [
          {
            q: "如何将 CodeBuddy 连接到 Petdex？",
            a: "运行 npx petdex install boba，打开 Petdex Desktop，按 Cmd+, 打开设置后点击 CodeBuddy 旁的连接按钮。",
          },
          {
            q: "更换宠物后需要重新连接 CodeBuddy 吗？",
            a: "不需要。代理 Hook 与当前宠物相互独立，你可以随时切换数百只社区宠物。",
          },
          {
            q: "已安装的宠物保存在哪里？",
            a: "CLI 会将宠物包下载到 ~/.petdex/pets/<slug>/ 目录中，内含 pet.json 和 spritesheet.webp。",
          },
        ],
      },
    },
  },
  {
    slug: "omp",
    name: "OMP",
    vendor: "Oh My Pi",
    icon: "/brand/agents/omp.svg",
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "Session hooks under PI_CODING_AGENT_DIR plus local read-only OMP session log recovery.",
    copy: {
      en: {
        title: "Animated Pixel Pets for OMP",
        subtitle:
          "Bring a reactive desktop pixel companion to OMP (Oh My Pi) with session hook integration and durable log recovery.",
        howItWorks:
          "Petdex Desktop monitors your OMP installation (including custom PI_CODING_AGENT_DIR paths), installs its native lifecycle hooks, and pairs them with local read-only OMP session log recovery so your floating pet never loses track of long-running agent tasks.",
        faqs: [
          {
            q: "How does Petdex connect to OMP?",
            a: "Install a pet with npx petdex install boba, launch Petdex Desktop, open Settings with Cmd+,, and click Connect on OMP.",
          },
          {
            q: "Does Petdex respect PI_CODING_AGENT_DIR?",
            a: "Yes. Both hook detection and durable session log watching honor PI_CODING_AGENT_DIR automatically.",
          },
          {
            q: "Does Petdex work on Linux Wayland compositors like Hyprland?",
            a: "Yes. Petdex Desktop supports wlr-layer-shell builds on Wayland as well as standard floating windows on GNOME, X11, macOS, and Windows.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para OMP",
        subtitle:
          "Lleva una mascota pixel reactiva a OMP (Oh My Pi) con hooks de sesion y recuperacion local de registros.",
        howItWorks:
          "Petdex Desktop detecta tu instalacion de OMP (incluyendo rutas personalizadas en PI_CODING_AGENT_DIR), instala sus hooks nativos y los combina con recuperacion local de solo lectura sobre los logs de sesion de OMP.",
        faqs: [
          {
            q: "Como conecto Petdex con OMP?",
            a: "Instala una mascota con npx petdex install boba, abre Petdex Desktop, pulsa Cmd+, y haz clic en Conectar junto a OMP.",
          },
          {
            q: "Petdex respeta la variable PI_CODING_AGENT_DIR?",
            a: "Si. Tanto la deteccion de hooks como la recuperacion de sesiones usan PI_CODING_AGENT_DIR automaticamente.",
          },
          {
            q: "Funciona en Linux con Wayland o Hyprland?",
            a: "Si. Petdex Desktop soporta ventanas flotantes en macOS, Windows, GNOME y X11, ademas de wlr-layer-shell en Wayland.",
          },
        ],
      },
      zh: {
        title: "适用于 OMP 的动态像素宠物",
        subtitle:
          "为 OMP（Oh My Pi）接入实时响应的桌面像素伙伴，支持会话 Hook 与只读日志恢复。",
        howItWorks:
          "Petdex Desktop 会自动检测本机 OMP 环境（支持自定义 PI_CODING_AGENT_DIR），安装原生生命周期 Hook，并结合本地只读会话日志恢复机制，让宠物在长任务期间始终保持状态准确。",
        faqs: [
          {
            q: "如何将 Petdex 连接到 OMP？",
            a: "运行 npx petdex install boba，打开 Petdex Desktop，按 Cmd+, 进入设置并点击 OMP 旁的连接按钮。",
          },
          {
            q: "是否支持 PI_CODING_AGENT_DIR 环境变量？",
            a: "支持。Hook 检测与本地会话日志监控都会自动读取 PI_CODING_AGENT_DIR。",
          },
          {
            q: "Linux Wayland（如 Hyprland）也能运行吗？",
            a: "可以。Petdex Desktop 原生支持 macOS、Windows 与 Linux，并在 Wayland 合成器下支持 layer-shell 悬浮层。",
          },
        ],
      },
    },
  },
  {
    slug: "dsh",
    name: "DeepSeek Harness",
    vendor: "DeepSeek",
    icon: FALLBACK_AGENT_ICON,
    installCommand: DEFAULT_INSTALL_COMMAND,
    hookMechanism:
      "Bundled @petdex/dsh-plugin Cordis bridge installed into the DSH Web profile (~/.dsh/profiles/web or $DSH_HOME/profiles/web).",
    copy: {
      en: {
        title: "Animated Pixel Pets for DeepSeek Harness (DSH)",
        subtitle:
          "Connect DeepSeek Harness Web sessions to Petdex Desktop via the bundled @petdex/dsh-plugin bridge.",
        howItWorks:
          "Petdex Desktop detects your DeepSeek Harness Web profile under $DSH_HOME/profiles/web or ~/.dsh/profiles/web and installs the embedded @petdex/dsh-plugin Cordis bridge. Once DSH Web restarts and emits a session event, your floating pixel pet reacts live to every run.",
        faqs: [
          {
            q: "How does Petdex connect to DeepSeek Harness?",
            a: "Start DSH Web at least once so ~/.dsh/profiles/web exists, install a pet with npx petdex install boba, then click Connect next to DeepSeek Harness in Petdex Desktop Settings.",
          },
          {
            q: "Does removing the DSH integration touch my models or sessions?",
            a: "No. Selecting Remove in Petdex Settings removes only @petdex/dsh-plugin from the DSH web profile and leaves all profiles, models, and sessions untouched.",
          },
          {
            q: "Does Petdex support a custom DSH_HOME directory?",
            a: "Yes. When DSH_HOME is set in the Petdex environment, Petdex reads $DSH_HOME/profiles/web instead of ~/.dsh/profiles/web.",
          },
        ],
      },
      es: {
        title: "Mascotas Pixel Animadas para DeepSeek Harness (DSH)",
        subtitle:
          "Conecta sesiones de DeepSeek Harness Web con Petdex Desktop mediante el puente integrado @petdex/dsh-plugin.",
        howItWorks:
          "Petdex Desktop detecta tu perfil de DeepSeek Harness Web en $DSH_HOME/profiles/web o ~/.dsh/profiles/web e instala el plugin integrado @petdex/dsh-plugin. Al reiniciar DSH Web y ejecutar una tarea, tu mascota pixel reacciona en vivo.",
        faqs: [
          {
            q: "Como conecto Petdex con DeepSeek Harness?",
            a: "Inicia DSH Web para crear ~/.dsh/profiles/web, instala una mascota con npx petdex install boba y haz clic en Conectar junto a DeepSeek Harness en Petdex Desktop.",
          },
          {
            q: "Eliminar la integracion afecta mis modelos o sesiones de DSH?",
            a: "No. Al elegir Remove en Ajustes de Petdex solo se retira @petdex/dsh-plugin del perfil web sin tocar modelos ni sesiones.",
          },
          {
            q: "Soporta un directorio DSH_HOME personalizado?",
            a: "Si. Si DSH_HOME esta definido en el entorno, Petdex usa $DSH_HOME/profiles/web en lugar de ~/.dsh/profiles/web.",
          },
        ],
      },
      zh: {
        title: "适用于 DeepSeek Harness (DSH) 的动态像素宠物",
        subtitle:
          "通过内置的 @petdex/dsh-plugin 桥接插件，让 DeepSeek Harness Web 会话实时驱动 Petdex 桌面像素宠物。",
        howItWorks:
          "Petdex Desktop 会自动检测 $DSH_HOME/profiles/web 或 ~/.dsh/profiles/web 中的 DSH Web 配置，并安装内置的 @petdex/dsh-plugin Cordis 桥接插件。重启 DSH Web 并产生任务事件后，宠物即会实时响应。",
        faqs: [
          {
            q: "如何将 Petdex 连接到 DeepSeek Harness？",
            a: "先运行一次 DSH Web 以生成 ~/.dsh/profiles/web，再执行 npx petdex install boba 安装宠物，最后在 Petdex Desktop 设置中点击 DeepSeek Harness 旁的连接按钮。",
          },
          {
            q: "移除集成会影响 DSH 的模型或历史会话吗？",
            a: "不会。点击移除只会从 DSH web profile 中卸载 @petdex/dsh-plugin，不会改动你的模型、会话或其他插件。",
          },
          {
            q: "支持自定义 DSH_HOME 目录吗？",
            a: "支持。如果环境中设置了 DSH_HOME，Petdex 会优先读取 $DSH_HOME/profiles/web。",
          },
        ],
      },
    },
  },
] as const;

const CODING_AGENT_BY_SLUG = new Map<string, CodingAgent>(
  CODING_AGENTS.map((agent) => [agent.slug, agent]),
);

export function getCodingAgent(slug: string): CodingAgent | undefined {
  return CODING_AGENT_BY_SLUG.get(slug);
}
