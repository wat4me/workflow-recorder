# Chrome Web Store 上传与审核说明

> 适用版本：1.3.0
> 核对日期：2026-10-10
> 上传包：dist/workflow-recorder-1.3.0-web-store.zip

本文内容根据当前源代码和 manifest.json 整理，可用于 Chrome Web Store 开发者后台的 Store listing、Privacy practices 和 Test instructions 页面。

## 提交前结论

商店 ZIP 的 manifest.json 位于压缩包根目录。扩展不连接开发者服务器，不加载或执行远程代码，录制数据和截图保存在用户本机的扩展存储中。Bridge 和执行记录实现已移除，不再申请 `nativeMessaging` 权限；“复制给AI”通过剪贴板交接任务说明。

代码仓库提交不等同于商店发布。提交当前 1.3.0 包到商店前，应优先复核以下审核事项：

1. 当前 UI 已在开始录制前提供知情同意，说明会记录网址、页面内容、操作、输入值和截图；隐私政策已补齐开发者信息，提交时须确认商店使用本文给出的公开链接，并确保数据披露与实现一致。
2. `content/main.js` 当前会记录 password 类型输入框的实际值，且该值会进入步骤卡片、Markdown 文档和导出 ZIP。必须选择“身份验证信息”数据类型，并在产品内显著披露；更稳妥的做法是发布前改为不记录或固定脱敏为占位符。
已解决、无需在提交前再处理的项：
- 最小权限集合。`activeTab` 已从 `manifest.json` 移除，因为代码中没有任何调用依赖它，且现有的 `<all_urls>` 主机权限已覆盖注入和页面读取需求。当前声明的权限为 `storage`、`unlimitedStorage`、`tabs`、`scripting`、`webNavigation`、`sidePanel`、`debugger`，逐项都有对应实现。
- 截图 Blob 清理。`background/store/media-cleanup.js` 实现了引用感知删除（`deleteUnreferenced`）、失败重试与 `pendingScreenshotDeleteKeys` 持久化补偿，并有定期孤儿清扫（`cleanupOrphans` 比对 IndexedDB 全部键与当前步骤/历史用例的引用）。删除步骤或用例时不再遗留无引用截图。

如果保持当前代码不变提交，必须使用本文“当前实现”口径如实披露，不能选择“不收集用户数据”。

## 一、商店信息（Store listing）

### 名称

流程录制

### 简短说明

记录网页操作和步骤截图，生成便于理解、复用和导出的流程文档。

### 详细说明（中文，可直接粘贴）

流程录制是一款面向网页流程梳理、AI 工作流理解和自动化复现的操作记录工具。它将用户录制的网页操作整理为清晰的 Markdown 流程说明，方便后续查看、复用或交给支持浏览器操作的 AI 工具处理。

用户主动点击“开始录制”后，扩展仅跟踪当前页面及由该页面打开的子标签页或子窗口，记录点击、文本输入、选择、按键、悬停、拖拽和页面跳转，并为操作步骤保存页面截图。录制结果会整理为带页面句柄、元素语义、浏览器计算的局部可访问性信息和必要 DOM 上下文的结构化步骤文档。

主要功能：

- 记录点击、输入、选择、按键、悬停、拖拽和页面跳转。
- 跟踪录制页面打开的子标签页与子窗口。
- 自动或手动保存步骤截图。
- 在侧边栏录制、查看和编辑步骤，在全屏用例工作台中查看、删除和管理已保存用例。
- 保存历史用例，支持三级文件夹分类、目录导航和移动；将单个或多个用例导出为包含 Markdown 文档和 JPG 截图的 ZIP 文件。
- 在侧边栏或全屏用例页面复制 Markdown 任务说明，粘贴到支持浏览器操作的 AI 工具中继续处理。
- 支持简体中文和英文界面。

隐私说明：扩展会处理用户主动录制页面的网址、标题、页面元素信息、操作记录、表单输入值和页面截图。这些数据仅用于在用户设备上生成、保存、预览和导出流程文档，保存在当前 Chrome 用户配置文件的扩展专用存储中，不会发送到开发者或第三方服务器，不用于广告、画像或出售。请勿录制不希望保存在本机或导出文件中的敏感内容。

录制开始时 Chrome 可能显示“正在调试此浏览器”的提示，这是扩展使用 Chrome DevTools Protocol 查询操作目标的局部可访问性信息，以及在启用截图时接收页面帧的正常行为。关闭截图时仍可能显示调试提示。停止录制后，扩展会立即断开调试会话。

本项目已开源，采用 MIT 协议。你可以在 GitHub 查看源码、反馈问题或参与贡献：
https://github.com/wat4me/workflow-recorder

### Detailed description (English)

Workflow Recorder is a browser interaction recorder for documenting web procedures, helping users understand workflows and reproduce them with AI or automation tools. It turns recorded web interactions into clear Markdown instructions that can be reviewed, reused, or provided to an AI tool with browser automation capabilities.

Recording starts only after the user clicks “Start recording.” The extension then tracks the selected page and descendant tabs or windows opened from that page. It records clicks, text input, selections, key presses, hovers, drags, and navigation events, and saves step screenshots. The result is a structured workflow document containing page handles, element semantics, local browser-computed accessibility context, and limited DOM context.

Key features:

- Record clicks, typing, selections, key presses, hovers, drags, and navigation.
- Track child tabs and windows opened by the recorded page.
- Capture automatic or manual step screenshots.
- Record, review, and edit steps in the side panel, and manage saved cases in the full-page workbench.
- Save workflow cases and export one or multiple cases as ZIP archives containing Markdown documents and JPG screenshots.
- Copy Markdown task instructions from the side panel or full-page case view and paste them into an AI tool with browser automation capabilities.
- Chinese and English user interfaces.

This project is open source under the MIT License. View the source code, report issues, or contribute on GitHub:
https://github.com/wat4me/workflow-recorder

Privacy: the extension processes URLs, page titles, element information, user interactions, form input values, and screenshots from pages the user explicitly records. This information is used only to generate, store, preview, and export workflow documentation on the user's device. It is stored in extension-specific storage in the current Chrome profile and is not sent to the developer or any third-party server, sold, used for advertising, or used for profiling. Users should not record sensitive content they do not want stored locally or included in exports.

Chrome may show a “debugging this browser” notification while recording. This is expected because the extension uses the Chrome DevTools Protocol to read local accessibility context for operation targets and, when screenshots are enabled, receive page frames. The debugger session is detached when recording stops.

### 建议分类

Productivity（生产力工具）

### 素材清单

- 已有：128×128 扩展图标。
- 待准备：至少 1 张 1280×800 或 640×400 的商店截图；优先使用 1280×800。建议准备 3 张，分别展示侧边栏录制、步骤截图大图、全屏用例管理与批量导出。
- 待准备：440×280 小型宣传图。
- 可选：1400×560 大型宣传图和 YouTube 演示视频。
- 截图中必须使用虚构或脱敏数据，不要出现真实账号、密码、Token、客户信息或内部网址。

## 二、隐私页面（Privacy practices）

### 单一用途说明（中文）

在用户明确启动录制后，记录所选网页及其子页面中的交互步骤和对应页面截图，并在用户设备本地生成、保存、预览和导出结构化流程文档。

### Single purpose description (English)

After the user explicitly starts a recording, capture interaction steps and corresponding screenshots from the selected web page and its descendant pages, then locally generate, store, preview, and export a structured workflow document.

### 权限说明（中文，可逐项粘贴）

storage：保存录制状态、页面映射、操作步骤、历史用例和相关配置。所有数据均保存在当前 Chrome 用户配置文件的扩展专用本地存储中。

unlimitedStorage：步骤截图和历史用例可能超过普通扩展存储配额。该权限仅用于在本机保存用户主动录制的工作流数据与截图，避免长流程因配额不足而丢失。

tabs：识别用户选择的录制标签页，读取其网址和标题，跟踪由该页面打开的子标签页，并在录制停止或页面关闭时清理对应会话。扩展不会记录与当前录制链路无关的标签页。

scripting：在用户开始录制的现有页面以及录制链路中的子页面中注入随扩展打包的事件采集和页面稳定性脚本。不会下载或执行远程脚本。

webNavigation：检测已纳入录制范围的页面完成导航，以便在新文档中恢复录制监听并记录导航步骤。不会用于构建用户的全局浏览历史。

sidePanel：在 Chrome 侧边栏中持续展示开始/停止按钮、录制步骤、可缩放截图预览以及当前用例的保存/导出操作。

debugger：通过 Chrome DevTools Protocol 接收页面截图帧，并读取操作目标的局部可访问性角色、名称、描述、值和状态。使用 Runtime.enable 跟踪执行上下文、Runtime.evaluate 获取扩展隔离世界中的临时元素引用、Runtime.callFunctionOn 在目标被忽略时读取最多三级父节点、DOM.describeNode 对应实际节点、Accessibility.getPartialAXTree 查询局部树，完成后释放远程对象引用；截图启用时使用 Page.startScreencast 等帧接口。不记录网络流量、Cookie、控制台或整页完整无障碍树。关闭截图后仍采集 AX；停止录制或页面关闭时 detach。

主机权限 <all_urls>：扩展的单一用途是记录用户选择的任意网页流程，因此需要在用户主动开始录制后读取页面元素、监听页面交互并获取截图。实际记录范围限于用户选择的根页面及其打开的后代标签页/窗口，不处理未加入本次录制链路的其他标签页。Chrome 内部页面不可录制。

### Permission justifications (English)

storage: Stores recording state, page mappings, interaction steps, saved workflow cases, and related configuration in extension-specific local storage in the current Chrome profile.

unlimitedStorage: Long workflows and step screenshots can exceed the default extension storage quota. This permission is used only to retain user-initiated workflow data and screenshots locally and prevent data loss caused by quota limits.

tabs: Identifies the selected recording tab, reads its URL and title, tracks descendant tabs opened by the recorded page, and cleans up sessions when tabs close. Tabs unrelated to the active recording tree are not recorded.

scripting: Injects packaged interaction-recording and page-stability scripts into an existing user-selected page and descendant pages in the active recording tree. The extension never downloads or executes remote scripts.

webNavigation: Detects navigation completion only in tabs already admitted to the recording session, so operation recording can resume in the new document. It does not generate navigation steps or build a global browsing history.

sidePanel: Provides the persistent Chrome side panel that contains recording controls, recorded steps, zoomable screenshot previews, and current-case save/export actions.

debugger: Receives screenshot frames and reads local browser-computed accessibility roles, names, descriptions, values and states for operation targets. Runtime.enable tracks execution contexts; Runtime.evaluate resolves temporary references in the extension isolated world; Runtime.callFunctionOn reads up to three parent nodes when the target is ignored; DOM.describeNode identifies the exact node; Accessibility.getPartialAXTree reads local AX context. Remote object groups are released after queries. Page.startScreencast and related frame commands run only when screenshots are enabled. Network traffic, cookies, console data and full-page AX trees are not recorded. AX collection continues with screenshots off; sessions detach on stop or tab close.

Host permission <all_urls>: The extension's single purpose is to record workflows on any website selected by the user. After explicit user initiation, it needs to inspect page elements, listen for interactions, and obtain screenshots on the selected root page and descendant pages it opens. Unrelated tabs are excluded, and Chrome internal pages cannot be recorded.

### 远程代码

选择：No, I am not using remote code.

说明：所有 JavaScript 均包含在扩展包内。ZIP 功能使用包内 vendor/fflate.js，并附带许可证文件。代码中没有 XMLHttpRequest、WebSocket、远程 script、eval 或 new Function。唯一的 fetch 调用出现在 shared/i18n.js 与 background/locale.js，且仅用于通过 chrome.runtime.getURL 读取扩展包内的 `_locales/<语言>/messages.json`，不产生任何网络请求。

### 数据类型选择（按当前 1.3.0 实现）

必须选择：

- Authentication information：当前会记录 password 输入框的实际输入值。
- Web history：记录被录制页面的网址和标题。
- User activity：记录点击、输入、选择、按键、悬停和拖拽。
- Website content：记录有限 DOM/ARIA 上下文、页面文本和截图。

合规优先的建议是同时选择以下类型，因为扩展可在任意页面录制，截图和表单输入可能包含这些内容：

- Personally identifiable information
- Personal communications
- Financial and payment information
- Health information
- Location

如果发布前实现密码排除、敏感字段脱敏和截图遮挡，应重新按修改后的真实行为判断数据类型，不能仅为减少勾选而不改代码。

### 数据使用认证

在事实保持为“仅本地处理、无第三方传输、无广告、无画像”的前提下，可勾选后台列出的 Limited Use 认证项，包括：

- 不向第三方出售或转移用户数据（政策允许的例外除外）。
- 不将用户数据用于或转移给与扩展单一用途无关的目的。
- 不将用户数据用于确定信用状况或贷款目的。

### 隐私政策 URL

Chrome Web Store 要求填写公开可访问的 HTTPS 地址。当前政策地址为 https://github.com/wat4me/workflow-recorder/blob/main/docs/PRIVACY_POLICY.md ，开发者为 wat4me，联系邮箱为 wat4mefoxmail@gmail.com。提交前请把商店后台原 ai-record 仓库链接替换为此地址。

## 三、审核测试说明（Test instructions）

### 中文版本

本扩展无需账号、付费订阅或外部服务。

1. 安装后打开 https://example.com/。
2. 点击工具栏中的“流程录制”图标，侧边栏将打开。
3. 点击“开始录制”。Chrome 可能显示调试提示条，这是使用 Page.startScreencast 获取步骤截图的预期行为。
4. 点击页面中的“More information...”链接，等待页面跳转。
5. 返回侧边栏，可以看到录制开始时的打开页面步骤，以及后续由用户触发的点击步骤和对应截图；登录跳转或刷新不会额外生成打开页面步骤。
6. 点击“停止录制”。调试会话会立即断开。
7. 点击“保存用例”，在弹窗中输入名称、选择保存分类并确认。点击“复制给AI”可将当前录制整理为 Markdown 并复制到剪贴板；停止录制后，宽屏通过“更多”中的“下载录制结果”，窄屏通过顶部下载按钮（空间不足时只显示图标），可下载包含 Markdown 流程文档和 screenshots 目录中 JPG 图片的 ZIP。
8. 若要测试输入和选择，可在 https://www.w3schools.com/html/html_forms.asp 中使用虚构的非敏感文本重复步骤 2 至 6。

限制：chrome:// 页面和其他 Chrome 内部页面无法录制；file:// 页面需要用户在扩展详情中手动允许访问文件网址。

### English version

No account, paid subscription, or external service is required.

1. After installation, open https://example.com/.
2. Click the Workflow Recorder toolbar icon. The side panel opens.
3. Click “Start recording.” Chrome may display a debugger notification; this is expected because local AX context is queried and Page.startScreencast is used when screenshots are enabled.
4. Click the “More information...” link and wait for navigation.
5. Return to the side panel. The open-page and click steps, with screenshots, should be visible.
6. Click “Stop recording.” The debugger session is detached immediately.
7. Click “Save as case,” enter a name, choose a destination folder, and confirm. Click “Copy for AI” to copy the current recording as Markdown, or use “Export recording” under “More actions” to download a ZIP containing a Markdown workflow document and JPG files in a screenshots folder.
8. To test typing and selection, repeat steps 2–6 on https://www.w3schools.com/html/html_forms.asp using fictional, non-sensitive text.

Limitations: chrome:// and other Chrome internal pages cannot be recorded. file:// pages require the user to enable file URL access in the extension details.

## 四、提交步骤

1. 先完成本文“提交前结论”中的隐私披露、密码处理和最小权限检查。
2. 修改代码后递增 manifest.json 的 version，重新生成 ZIP，并确保 manifest.json 在 ZIP 根目录。
3. 在 Chrome Web Store Developer Dashboard 打开原扩展条目并上传 ZIP。
4. 填写 Store listing，上传商店截图和宣传图。
5. 在 Privacy practices 中填写单一用途、逐项权限说明、远程代码声明、数据类型和 Limited Use 认证。
6. 填写公开的隐私政策 HTTPS URL。
7. 粘贴 Test instructions，建议选择 deferred publishing，审核通过后再手动发布。
8. 提交后如发现问题，取消审核、上传更高版本号的新包，再重新提交。

## 五、官方参考

- 发布流程：https://developer.chrome.com/docs/webstore/publish/
- 隐私字段：https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
- 测试说明：https://developer.chrome.com/docs/webstore/cws-dashboard-test-instructions
- 用户数据 FAQ：https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
- 2026 年政策更新：https://developer.chrome.com/blog/cws-policy-updates-2026
