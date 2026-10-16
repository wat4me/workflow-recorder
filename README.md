# 流程录制（Chrome 扩展）

源码仓库：[wat4me/workflow-recorder](https://github.com/wat4me/workflow-recorder)。本项目采用 [MIT License](LICENSE)，允许使用、修改和商业分发，须保留版权和许可声明。第三方组件保留各自的许可证，见 `vendor/fflate-LICENSE.txt`。

流程录制是一个面向 AI 工作流理解与自动化复现的 Chrome Manifest V3 扩展。它记录网页中的点击、输入、选择、按键、悬停、拖拽、页面跳转和子页面操作，并结合 DOM 定位信号、ARIA 语义及步骤截图，生成结构清晰的操作文档。

步骤文档示例：

```text
2. [page1] click <a id="sure"> -> link "确定"
```

文档保留动作、页面句柄、元素开标签、ARIA 角色、可访问名称和必要的 DOM 上下文，不生成脆弱的 `nth-of-type` CSS 路径，也不直接生成自动化代码。

## 主要功能

- 记录点击、文本输入、下拉选择、按键、悬停和拖拽操作。
- 连续输入按控件防抖合并，停止输入约 `700ms` 或控件失焦后提交最终输入步骤。
- 自动跟踪录制页面递归打开的子标签页和独立窗口。
- 页面句柄按 `page1`、`page2`、`page3` 顺序分配。句柄绑定的是标签页，不是文档：同一标签页内的跳转沿用原句柄，只有新标签页或新窗口才占用下一个编号。
- 只有全新录制开始时的根页面会生成一次「打开页面」步骤；登录跳转、应用重定向、刷新和后续打开的页面不单独生成页面步骤。
- 使用 CDP `Page.startScreencast` 持续接收页面帧，步骤截图直接读取对应标签页的最新缓存帧。
- 每个 `Page.screencastFrame` 都会通过 `Page.screencastFrameAck` 确认，避免帧推送阻塞。
- 自动为一个操作步骤保留“操作前 / 操作后”两帧；两张截图共同说明页面变化，但步骤数仍只计 `1`。
- 录制中可点击“更新操作后截图”，更新当前页面最后一个操作的操作后截图，不改变操作前截图，也不新增步骤；按钮在空间不足时只显示图标。
- 侧边栏顶部提供开始/停止/继续录制；停止录制后，宽屏通过“更多”下载录制结果，窄屏直接显示下载按钮，空间不足时只显示图标。步骤列表上方可清空当前工作区步骤。
- 支持步骤删除和自动滚动到最新步骤；删除步骤或历史用例时会清理不再被引用的截图 Blob。
- 支持保存历史用例、加载后继续录制、多选导出文档，以及导入/导出可协作的 `.swrcase` 用例包。
- 支持侧边栏录制与全屏用例工作台两种操作界面。
- “复制给AI”重新读取最新已保存的步骤并整理为 Markdown 任务说明，可粘贴到 AI 工具中继续处理；读取失败时会提示错误。
- 点击按钮内的图标或文字时，优先记录所属交互控件，并单独保留原始命中节点；DOM 提示与浏览器计算的 AX 信息分别输出，AX 超时保留 DOM 和查询阶段诊断。
- 支持通过 JS 绑定事件的自定义 span/div 控件，通过实际页面变化校验点击。iframe 内关闭父弹层时，记录源 iframe 关闭，父页面可以继续录制。
- DOM 上下文优先保留测试标记及 ARIA 属性，较长的目标 HTML 会降为完整开标签并标注截断，结构化属性提示单独输出。
- 支持简体中文和英文界面，可通过右上角语言按钮手动切换并记住选择。
- 界面统一使用亮色主题，按钮共享悬停、按下和键盘聚焦反馈；禁用按钮不响应悬停，减少动态效果偏好下不显示按钮位移。
- 导出的 AI 操作文档保持稳定的英文结构，便于程序和模型消费。

## 安装

1. 打开 Chrome，在地址栏访问 `chrome://extensions/`。
2. 开启右上角的“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本项目根目录。
5. 在扩展程序菜单中将“流程录制”固定到工具栏。

修改代码后，需要在 `chrome://extensions/` 中点击扩展的“重新加载”。

## 使用方法

### 1. 开始录制

点击“开始录制”后，扩展会：

1. 将当前目标标签页绑定为录制根页面。
2. 在用户点击扩展后按需注入语义分析器和操作采集脚本，不再对所有网页静态注入。
3. 通过 `chrome.debugger` 连接标签页并启动 `Page.startScreencast`，用于采集步骤截图。
4. 记录根页面以及它递归打开的子标签页和子窗口。

手动切换到与录制链路无关的标签页不会被记录。

### 2. 操作页面

侧边栏会实时展示录制步骤和截图，并自动滚动到最新内容。截图异步加载导致卡片高度变化后，也会再次滚动到底部。点击截图可在侧边栏内预览；预览标题过长时会显示省略号，悬停可查看完整描述，并可使用左右按钮或键盘方向键切换当前录制中的前后截图。侧边栏预览不显示“适应窗口”按钮，双击画布仍可适应窗口。

打开侧边栏时，仅向顶层页面加载布局脚本，宽页面会自动缩小以适应剩余空间；点击开始或继续录制后，才向页面及 iframe 加载完整录制脚本。页面缩放引起的尺寸变化、仅高度变化及重复打开通知不会反复恢复并重新缩放页面；窗口宽度变化或检测到新的横向溢出时才重新适配，关闭侧边栏会恢复原来的缩放。

无关标签页各自保留独立草稿：在 B 页面打开侧边栏时，会暂停并保留 A 的录制，展示 B 自己的步骤；切回 A 后点击“继续录制”即可接着录。暂停会先提交输入框里尚未提交的内容，再保存步骤和截图。录制期间由 A 打开的子页面仍共用 A 的草稿，打开子页面侧边栏不会暂停或拆分录制。

侧边栏的“当前草稿”下拉框可切换已保留草稿，标签页关闭后也能从其他页面找回；切换草稿不会自动生成已保存用例。清空只影响当前草稿，其他草稿及其截图会保留。草稿保存在本机，后台重启后仍可读取；浏览器重启后旧标签页绑定会清除，可通过下拉框恢复草稿到当前页面。一次只录制一份草稿，切换到其他草稿后需要手动开始或继续录制。

打开子页面时：

- 父页面的点击步骤保留操作语义。
- 子页面不生成 `newPage` 或 `navigate` 步骤。
- 子页面的操作和截图使用新的页面句柄，例如 `page2`。

页面截图会等待 DOM 静默及业务加载控件消失。当前识别的业务加载控件包括：

```text
div[class*="loading_progress"]
div.common_loading_progress_box
div.ctpUiLoading div.loaderIcon
div.menu-setting-loading
div.loaderIcon
div.ant-spin-nested-loading .ant-spin-dot
.cap4-loading
div.v-easy-table-loading
div.gBlock
div#nprogress
```

同时支持 `aria-busy="true"`、`data-loading="true"`、`data-busy="true"`、`role="progressbar"` 和原生 `progress` 元素。

### 3. 停止录制

点击“停止录制”后，扩展会：

1. 停止所有已跟踪页面的操作监听。
2. 等待操作写入队列结束。
3. 等待截图任务消费完成。
4. 调用 `Page.stopScreencast`。
5. 通过 `chrome.debugger.detach` 释放所有标签页的 CDP 会话。

### 4. 保存和继续录制

- 点击“保存为用例”可填写名称并选择保存分类，保存当前步骤快照。可选择“未分类”或工作台中的已有文件夹；从已有用例继续录制时默认选中原分类。
- 已保存用例统一在全屏用例工作台中查看和加载。
- 进入文件夹后，右侧列表会在用例前平铺显示其直接子文件夹，通过文件夹和文档图标区分，可点击进入下一层，或通过“更多”菜单重命名、移动、删除；子文件夹的用例数量包含其后代目录。
- 加载历史用例后，主按钮显示“继续录制”。
- 继续录制时保留原有步骤，并追加新的操作。
- 需要重录时，先点击“清空步骤”并确认，再点击“开始录制”。清空不会自动保存或开始录制，也不会影响已保存用例；需要保留当前内容时，请先保存用例。

### 工作台操作

工作台中，点击“用例文件夹”标题旁的加号新建根文件夹。顶部“导入用例”用于导入 `.swrcase` 用例包；选择用例后，“导出文档”下载供阅读的 Markdown 和截图 ZIP，“分享用例包”生成可再次导入插件的 `.swrcase` 文件，“删除”删除已选用例。按钮的悬停说明会解释各自用途。

删除确认会先算一遍要删的东西，并如实写出释放量：这些用例共有多少步骤、多少张截图，其中多少张在删除后**不再被任何其他用例引用**，只有那部分会被真正回收。见下面「截图共享与删除」。

左侧目录和“移动至”弹窗中，有子文件夹的目录可通过左侧箭头展开或收起；点击目录名称仍用于选择目录。两处折叠状态独立，并在当前工作台页面的列表刷新后保留。

目录行的“更多”提供重命名、移动和删除。拖动目录名称到另一目录可将整棵子树移入，拖到“用例文件夹”标题可移回根目录；也可通过“移动文件夹”弹窗选择目标。移动不会更改用例内容，不允许移入自身/子目录、超过三级或产生同级重名。

### 已有用例兼容

精简版保留录制、保存、继续录制、用例库、搜索、文件夹和导入导出。旧版本创建的场景用例仍可在用例库中按步骤查看、继续录制和导出。关系图、从中间派生及场景编排的完整实现保存在 codex/full-workbench 分支。

### 历史用例的存储升级

用例数据从「单个数组」改为「索引 + 单用例记录」（`caseIndex`、`case:<id>`、`caseMedia:<id>`）。首次启动新版本时会自动完成一次升级：

- 升级过程分批进行，中途被浏览器终止后会在下次启动继续。
- 只有新结构写入并校验通过后，才会删除旧数据。
- 升级未完成时，已保存的用例仍可查看和导出，但暂时无法新建、保存或删除用例。
- 升级失败会保留旧数据并在下次启动重试，不需要手动删除历史记录。

升级到新结构后，旧版本扩展无法再安全写入这些用例数据。

## 截图机制

步骤截图使用 push 模式，不再在每个操作后调用 `chrome.tabs.captureVisibleTab()` 或 `Page.captureScreenshot`。

```text
录制开始
  -> chrome.debugger.attach
  -> Page.enable
  -> Page.startScreencast
  -> 持续接收 Page.screencastFrame
  -> 立即发送 Page.screencastFrameAck
  -> 每个标签页缓存最新 JPEG 帧

截图队列开始排空
  -> 操作消息到达时，立即从对应标签页缓存复制“操作前”帧并绑定到该步骤
  -> 逐个处理任务：
       等待页面稳定
       -> 若该标签页尚无缓存帧，请求页面制造一次重绘以产生帧
       -> 读取该标签页的最新 screencast 帧
       -> 以全新的 screenshot:<步骤 ID>:<采集 ID> 键保存到 IndexedDB
       -> 将新键绑定到操作步骤，并回收它替换掉的旧键（无人引用时才真正删除）
```

### 步骤截图状态

每个步骤上都持久化了截图状态，卡片据此显示"等待截图 / 系统截图中 / 手动截图中 / 已截图 / 无需截图 / 重拍中 / 重拍失败 / 无截图"。手动截图入口位于侧边栏，不向被录制页面注入可见按钮。

"无需截图"和"无截图"是两件事：前者是录制器主动决定不截（例如这一步点击打开了新页面，父页面的画面本来就不该要），后者是本该有帧但没拿到。两种缺失都会在卡片上补出具体原因，例如"无需截图 · 点击打开了新页面"或"无截图 · 页面已关闭"。原因使用稳定错误码而不是当时的提示文本，所以切换语言后仍然正确。

- 步骤卡片把两帧并排显示为“操作前 → 操作后”，它们共享同一个步骤序号和动作描述，不会被拆成两个步骤。
- 旧数据或技术上无法取得其中一帧时，卡片仍显示已有的单帧；不会为了凑成一对而复制错误画面。
- 已经有截图的步骤在重拍时保留原图并叠加进行中状态；重拍失败也继续显示上一张，不会退回空白。
- 截图队列只存在于后台内存中。录制期间被录制页面会持有一个长连接，避免后台被浏览器回收——否则"点一下、然后安静地读页面半分钟"就足以让后台连同截图队列一起被回收。
- 后台仍被回收时（例如浏览器主动释放内存），正在等待的步骤没有截图会到来，因此会在下次启动时明确标记为失败，而不是永久停在"等待截图"。这类步骤可以用手动截图按钮重新采集。
- 每次采集都使用新的截图键，不覆盖旧文件。这样加载历史用例后重拍，不会改变该用例已保存的截图。

侧边栏中的手动截图按钮只在录制中且存在步骤时启用。自动或手动截图正在处理时，按钮暂时禁用，避免同一页面产生并发截图任务。

### 为什么需要主动重绘

`Page.startScreencast` 只在页面**发生重绘**时推帧。已经静止的页面一帧都不会产生，重启 screencast 也不会产生（实测确认）。

因此在没有缓存帧时，扩展会请求页面在一个临时 Shadow DOM 内添加并立即移除一个 1×1、约 1% 透明度的元素，制造一次重绘。该临时节点只在需要新帧时存在，页面上没有可见的截图控件。

每个录制标签页拥有独立的 screencast 会话和帧缓存，因此截图不依赖标签页是否处于活动状态。Screencast 不设置 `maxWidth/maxHeight`，按各标签页当前的原生可视区域分辨率输出并自然跟随窗口尺寸变化；JPEG 质量为固定值 `75`，每四帧采样一帧，以平衡帧的新鲜度与多标签页录制开销。

### 截图设置

录制设置支持两项独立选项：

- **录制时保存步骤截图**：修改在下次开始或继续录制时生效，不影响正在进行的录制。关掉后不采集或保存截图，操作步骤及浏览器可访问性（AX）信息仍会记录，因此 Chrome 仍可能显示调试提示。
- **侧边栏截图默认展开**：默认开启。关闭后，侧边栏的截图默认折叠，可通过每一步的“展开截图”按钮查看前后截图，再次点击可收起。保存后立即生效，并记住设置；折叠时不加载隐藏的缩略图。此选项不影响截图采集、原图保存、用例工作台预览或导出。

截图保持原始分辨率，不提供清晰度档位。录制时保存原始 JPEG 和对应的目标坐标，不再为了红框逐步解码、绘制全尺寸画布并重新编码。列表按需生成并缓存最长边 320 像素的缩略图，离屏后释放图片；超过 200 步时只创建可见范围附近的卡片。放大预览用原图叠加红框，缩放和拖动保持同步；文档 ZIP 导出时才逐张合成带框图片。旧截图已包含红框，会继续直接显示。

用例包保存原图及高亮坐标，导出按块写入 ZIP，导入按块解压并逐项写入 IndexedDB，失败会回滚暂存图片。图片缩略图与原图一同清理。步骤变化直接更新对应卡片，完整刷新会合并并串行执行。

旧版每步绘制红框的内存测量不能用于推算当前版本收益；真实浏览器进程内存仍需在相同页面、步骤数和窗口尺寸下重复对比。

如果标签页在截图前被关闭，扩展会结束该步骤的截图任务并记录截图不可用，不会使用父页面或其他标签页的画面冒充结果。

## 导出结构

### 单用例导出

假设用例名称为 `采购审批`，下载文件为：

```text
采购审批.zip
```

压缩包结构：

```text
采购审批/
├── 采购审批.md
├── screenshots/
│   ├── step-001-navigate-before.jpg
│   ├── step-001-navigate-after.jpg
│   ├── step-002-click-before.jpg
│   └── step-002-click-after.jpg
```

Markdown 中的截图引用使用相对路径：

```markdown
## Step screenshots

- Step 1 before: screenshots/step-001-navigate-before.jpg
- Step 1 after: screenshots/step-001-navigate-after.jpg
- Step 2 before: screenshots/step-002-click-before.jpg
- Step 2 after: screenshots/step-002-click-after.jpg
```

导出包不包含 JSON 文件。

### 批量导出

历史面板支持勾选多个用例并批量导出：

```text
批量用例-2026-08-27.zip
├── 登录流程/
│   ├── 登录流程.md
│   └── screenshots/
└── 采购审批/
    ├── 采购审批.md
    └── screenshots/
```

批量导出时，ZIP 内的同名目录会自动追加序号：

```text
采购审批/
采购审批-2/
采购审批-3/
```

导出名称会清理 Windows 非法字符、保留名称、末尾句点和空格。

### 浏览器可访问性上下文（AX）

每个有目标元素的操作分别保存 DOM 快照和浏览器计算的 AX 信息：角色、名称、描述、值、常用状态和最多三级父级上下文。拖拽同时保留源元素与目标元素的信息。复制给 AI、预览和导出文档时分别展示，AX 名称为空时不根据 DOM 或图标猜测补齐。

目标被浏览器标记为 ignored 时，文档说明该元素未作为独立可访问性节点暴露，并保留 DOM 定位依据；最多向上查询三级 DOM 父节点，找到有用的 AX 信息时另列为父节点参考，不冒充点击目标。旧录制也会使用新的 ignored 提示，但补充父节点信息需要重新录制。

采集在收到操作事件后尽早开始，可能反映页面即时更新后的状态，不保证是操作前快照。查询最多等待 500ms；失败、超时、节点消失或所在帧不可访问时明确标记不可用，继续记录 DOM 和步骤。内部节点引用不会写入步骤，也不能用于下一次打开网页定位。关闭截图时继续采集 AX，但不会启动截图帧流。

### 用例名称与重名处理

- 用例名称最多 120 个字符，粘贴超长文本时自动截断。
- 同一文件夹内保存、导入或移动用例遇到重名，会自动添加 `（2）`、`（3）` 等编号，不覆盖原用例；英文名称忽略大小写。
- 不同文件夹允许使用相同名称。手动重命名与当前文件夹内其他用例冲突时，会提示修改名称。
- 侧边栏手动保存时，在保存弹窗内检查所选文件夹的重名，提示修改名称或切换文件夹后再保存。
- 已有的同名用例保留原状，不会批量修改历史名称。

### 与同事分享用例

打开「用例历史」，勾选一个或多个已保存用例：

- 点击「分享用例包」，下载可重新导入的 `.swrcase` 单文件。文件包含步骤、页面信息、已有来源元数据及操作前/后的截图；多个用例引用同一截图时只保存一份。
- 同事点击「导入用例」选择该文件。导入不会覆盖当前工作区，也不会覆盖本机同名用例；系统会重建内部 ID，并在用例库中展示导入结果。
- 只选择派生用例而不选择其来源时，该用例会作为独立根用例导入；同时选择父子用例时会保留它们的关系。

普通 ZIP 或不兼容版本会被拒绝。导入写入失败时，已经暂存的截图会自动回滚。

## 操作文档示例

```markdown
# Recorded Workflow

Time: 2026-08-25 15:30 · Steps: 6 · Pages: 2

[page1] https://example.com/login "Login"
     -> https://example.com/home "Home"
[page2] https://example.com/report "Report"

1. [page1] open https://example.com/login "Login"
2. [page1] type <input id="username"> -> "alice"
3. [page1] select <select id="role" name="role"> -> "Admin"
4. [page1] press Enter on <input id="password" type="password">
5. [page1] click <a id="sure"> -> link "Confirm"
   page url: https://example.com/home
6. [page1] click <a id="report-link"> -> link "Report"
   -> opens page2
7. [page2] click <a id="print"> -> link "Print"
8. [page1] click <button id="close-win"> -> button "Close"
   page closed after this step
```

文档设计：

- 元素使用精简的 DOM 开标签表示，保留 `id`、`name`、`type` 和有限的 class 信息。
- 优先使用 ARIA role、`aria-label`、关联 label 和可访问名称。
- 分析器给不出可访问名称时回退到元素自身的可见文本。普通 `div` 不属于"可由内容命名"的角色，所以像 `<div class="navText">新建事项</div>` 这样的点击目标以前在文档里完全没有名字。回退沿用卡片标签原本的长度上限（不超过 32 字、不超过 3 个词），整段容器文本不会被当成控件名。
- 只有在既没有可访问名称、也没有可用的自身文本时，才附加附近文本和最多五层 DOM 上下文。
- 自动过滤 `style` 和 `on*` 事件属性。
- 导出文档结构保持英文，但页面标题、控件名称和输入值保留原始语言。
- 页面句柄绑定的是标签页而不是文档，所以同一标签页内的跳转不会产生新句柄。页头为此列出每个句柄**经过的全部 URL**，并在某个步骤的 URL 与上一步不同时补一行 `page url:`。登录跳转、应用重定向和单页路由跳转本身仍不生成步骤，但它们造成的坐标变化会如实出现在文档里。
- 页面生命周期单独写出：`-> opens page2` 标注是哪一步打开了子页面、之后的操作落在哪个句柄上，`page closed after this step` 标注页面在哪里消失。这两件事光看步骤列表无法还原——一个中途出现的句柄会显得来路不明，一个因为窗口关闭而结束的流程会显得只是断掉了。
- 打开子页面这件事记录在步骤自己的 `openedChildPage` 字段上，不复用截图跳过原因：后者属于截图流水线，会在整个录制未启用截图时被覆盖成 `capture-disabled`，也会在事后重拍成功时被清空。页面事实必须比截图活得久。

## 数据存储

历史用例和当前工作区数据保存在扩展专用的 `chrome.storage.local`：

```text
actions
cases
activeCaseId
tabsMapping
recordingTabIds
nextPageNumber
```

截图 Blob 保存在 IndexedDB：

```text
Database: PlaywrightRecorderDB
Object store: blobs
```

常见键：

```text
screenshot:<actionId>:<captureId>
screenshot:<actionId>:b<captureId>  # 操作前帧
```

这些数据属于当前 Chrome 用户配置文件。卸载扩展、清除扩展数据或删除用户配置文件会移除数据。

当前工作区和历史用例可能引用同一个截图键。删除步骤或用例时，扩展会先检查其他步骤及历史用例的引用，只删除已经没有任何引用的截图 Blob。

### 截图共享与删除

**步骤不共享，截图共享。** 每个用例把自己的步骤完整存一份（`case:<id>`），删掉就没有了；但截图只按 key 引用（`caseMedia:<id>` 是一串 key），同一个 Blob 可以被多个用例指着。

从某个用例继续录制得到的用例，继承的那部分步骤和来源用例引用**同一批截图**。所以删除一个用例时：

- 只删它引用的、且**删除后不再被任何其他用例或当前工作区引用**的截图
- 被其他用例或工作区指着的那些会保留下来

这意味着**删掉一个派生用例可能一张截图都回收不了** —— 它的截图来源用例还在引用。只有把引用它的用例也删掉，那部分才真正释放。

删除确认弹窗会把这件事说清楚：它用一个只读的预览（`previewCaseDeletion`）算出「共 N 个步骤、M 张截图，其中 K 张会一并删除」。K 明显小于 M 时，就说明大部分截图仍被别的用例共享。

预览和真正的删除走的是**同一个引用检查入口**（`mediaCleanup.referencedKeys`，只是预览传入了"即将删除的用例"把它们排除在外），所以它承诺的数字和实际发生的结果不会不一致。

删除失败的截图键会记录到后台待清理列表并自动重试。Service Worker 后续启动时会扫描 IndexedDB，清理不再被当前工作区或历史用例引用的孤儿截图；录制进行中会跳过常规全量扫描，避免与截图写入竞争。

## 权限说明

`manifest.json` 使用以下主要权限：

- `storage` / `unlimitedStorage`：保存操作步骤、历史用例和截图。
- `tabs`：识别录制标签页及子页面，读取其网址和标题。
- `scripting`：向目标页面动态注入录制脚本。
- `webNavigation`：在已跟踪页面导航后恢复录制。
- `sidePanel`：显示持久侧边栏。
- `debugger`：通过 Chrome DevTools Protocol 接收截图帧，并查询操作目标的局部可访问性上下文。

`debugger` 权限用于页面帧推送和操作目标的局部可访问性树查询。DOM 上下文与浏览器计算的 AX 信息分别保存，复制给 AI 和导出文档时一起提供；不采集整页完整 AX 树。查询失败或节点消失时保留 DOM 并注明 AX 不可用。Chrome 在录制期间可能显示调试提示，关闭截图时也可能显示。

## 项目结构

顶层目录按运行环境划分，这是 Chrome 强制的边界：Service Worker、被录制页面和扩展页面三者不共享作用域。每个目录内部再按职责拆分子目录。

### 后台模块（Service Worker）

`background/main.js` 是装配入口；消息路由和 Chrome 事件注册分别由独立模块承接。

- `background/router.js`：消息分发。`action` 名到处理函数的映射，统一处理异步响应和错误包装。
- `background/routes.js`：工作区、用例与截图的应用消息边界。
- `background/browser-events.js`：标签页、窗口、导航和 keepalive 事件注册。
- `background/install.js`：安装与升级引导，保留工作区数据、重置运行态、清理废弃键。
- `background/locale.js`：Service Worker 侧翻译，以及供内容脚本读取的 `_locales` 目录服务。
- `background/side-panel.js`：按标签页启用侧边栏，以及侧边栏打开时的页面缩放同步。
- `background/queue.js` / `background/timing.js`：串行任务队列与延时工具。
- `background/recording/scope.js`：录制范围。哪些标签页属于本次录制，以及用于归因的浏览器变更窗口。
- `background/recording/session.js`：录制启停生命周期。
- `background/recording/injection.js`：内容脚本注入及注入文件清单。
- `background/recording/action-log.js`：页面句柄分配、仅首个根页面导航放行、连续输入合并、点击有效性判定、步骤删除。
- `background/capture/screencast.js`：CDP 会话、`Page.startScreencast`、帧缓存、ACK 和 debugger 清理。
- `background/capture/screenshots.js`：截图任务队列、页面稳定等待和持久化流程；图像处理与键生成位于同目录独立模块。
- `background/store/actions.js`：按 `actionOrder` + `action:<id>` 组织的步骤存储。
- `background/store/cases.js`：历史用例命令和工作区生命周期。
- `background/store/media-cleanup.js`：引用感知的截图清理、重试和孤儿扫描。引用集合的唯一入口，删除预览也走这里，所以它承诺的释放量和实际结果不会分叉。
- `background/store/schema.js`：存储结构版本校验。

### 页面采集模块（被录制页面）

- `content/main.js`：录制会话与点击、按键、悬停编排。
- `content/targeting.js`：交互元素定位与指针坐标换算。
- `content/drag-recorder.js` / `content/input-recorder.js`：拖拽状态机与输入提交。
- `content/analyzer.js`：元素语义、ARIA、可访问名称和 DOM 上下文分析。
- `content/stability.js`：点击效果、DOM 静默和业务加载控件检测。
- `content/page-fit.js`：侧边栏打开时的宽页面缩放与恢复。
- `content/screencast-frame-primer.js`：按需创建的页面重绘辅助器，用于在缺少新帧时触发截图刷新。

这些文件不在 `manifest.content_scripts` 中声明，而是由 `background/recording/injection.js` 在用户主动调用扩展后动态注入。

### UI 模块（扩展页面）

- `ui/popup-entry.js` / `ui/console-entry.js`：页面唯一的 ES-module 入口，显式声明内部依赖。
- `ui/popup.html` / `ui/popup.js`：Chrome 侧边栏界面。
- `ui/console.html` / `ui/console.js`：全屏用例库和只读步骤预览。
- `ui/styles/base.css` / `ui/styles/console.css`：按基础、控件、步骤和预览职责聚合样式。
- `ui/styles/theme-refresh.css` / `ui/styles/tokens.css`：侧边栏与工作台共用的颜色、字号和控件状态；`ui/lib/icons.js` 提供本地 SVG 操作图标。
- `ui/app/recorder-panel.js`：侧边栏录制控制、当前工作区保存和导出。
- `ui/app/case-workbench.js`：全屏用例管理、批量文档导出、分享包、导入和删除。
- `ui/app/step-view.js`：共用的步骤卡片和截图缩略图。
- `ui/lib/dom.js`：无依赖的 DOM 叶子工具。
- `ui/lib/bridge.js`：与 Service Worker 的唯一通信通道，含超时兜底。
- `ui/lib/dialogs.js`：替代 `alert` / `confirm` / `prompt` 的弹窗与轻提示。
- `ui/lib/consent.js`：首次录制前的数据披露同意流程。
- `ui/lib/export.js`：ZIP 导出、文件名净化和下载触发。
- `ui/lib/case-package.js`：可移植 `.swrcase` 用例包的生成、校验、导入与媒体回滚。
- `ui/lib/image-preview.js`：截图全尺寸查看。
- `ui/lib/doc-generator.js`：AI 友好的英文步骤文档生成器。

HTML 只引用页面入口，内部加载顺序由 ES-module import 图维护。

### 共享模块

- `shared/i18n.js`：界面国际化。同时用于 Service Worker、内容脚本和扩展页面。
- `shared/protocol.js`：跨上下文消息名的唯一来源。
- `shared/media-store.js`：后台与 UI 共用的步骤截图 IndexedDB Blob 存储。
- `vendor/fflate.js`：ZIP 生成依赖。
- `_locales/`：中英文词条。

### 测试

- `test/analyzer.test.js`：语义分析器测试。
- `test/generator.test.js`：文档生成器测试。
- `test/capture-config.test.js`：最小权限集合、仅截图能力边界、入口文件和图标配置测试。
- `test/screencast-config.test.js`：push 截图模式、ACK 和 pull API 移除检查。
- `test/i18n.test.js`：中英文词条和引用完整性测试。
- `test/package.test.js`：打包范围、注入脚本清单和脚本命令测试。
- `e2e/lifecycle.spec.js`：真实 Chromium 扩展生命周期、多页面录制、截图、导出和历史用例测试。

结构类测试（`capture-config`、`screencast-config`、`i18n`）通过递归遍历源码目录来收集文件，而不是维护一份手写清单，避免新增或移动文件后静默失去覆盖。

## 开发与测试

安装依赖：

```bash
npm install
```

运行检查：

```bash
npm run check             # 检查全部项目 JS 模块语法
npm run lint              # 当前等同于全量 JS 语法检查
npm test                  # 运行 Node 单元和配置测试
npm run test:integration  # 运行真实 Chromium 扩展生命周期测试
npm run test:all          # 依次运行单元测试和集成测试
npm run extension:key     # 从本机私钥重算并验证固定扩展 ID
npm run package           # 重建 dist 展开目录、ZIP 和文件清单
```

开发版使用 `manifest.json` 中的公开 `key` 固定扩展 ID。私钥保存在项目目录之外的用户目录 `~/.extension-keys/workflow-recorder/extension-key.pem`（Windows 示例：`C:\Users\用户名\.extension-keys\workflow-recorder\extension-key.pem`），不能提交、公开或放入扩展加载目录。首次建立新扩展身份时使用 `npm run extension:key:create`；后续电脑应通过安全通道恢复同一私钥到该目录，或直接使用仓库中已经写入的公开 manifest key。没有私钥时不要重新创建密钥，否则会生成不同扩展 ID。

发布流程和架构说明分别见 `RELEASE.md` 与 `ARCHITECTURE.md`。提交前请运行下方的本地验证命令。

首次运行浏览器集成测试前安装 Playwright Chromium：

```bash
npx playwright install chromium --no-shell
```

## 排查漏记的操作

录制器会主动丢弃大部分点击 —— 页面上绝大多数点击不是流程步骤，全部记下来只会把真正的步骤淹掉。但这些丢弃以前是完全静默的，所以"我点了，为什么没记上"事后无从查证。

现在每一道丢弃都有带固定前缀的原因码：

```text
[Workflow Recorder] click not recorded: <reason>
```

| 原因码 | 含义 | 在哪里看 |
| --- | --- | --- |
| `not-recording` | 该 frame 的内容脚本认为没有在录制 | 被录制页面控制台 |
| `untrusted-event` | 浏览器标记为页面脚本合成的事件，不是人的操作 | 被录制页面控制台 |
| `meaningless-target` | 未命中元素，或点击了 body/html 页面根节点 | 被录制页面控制台 |
| `editable-target` | 输入类元素；输入值由 `type` 步骤记录 | 被录制页面控制台 |
| `drag-suppressed` | 刚刚完成一次拖拽，这次点击是它的尾巴 | 被录制页面控制台 |
| `no-observable-effect` | 等待窗口内没有观察到 DOM 变化、跳转、新页面或源 iframe 关闭/导航 | Service Worker 控制台 |

`no-observable-effect` 只能在后台判定，因为它需要跨标签页的视角；它的日志会附带当时实际观察到的 `domChanged`、`navigated`、`url` 和等待时长，用来区分"确实没效果"和"信号没到"。

日志走 `console.debug`：正常录制时保持安静，排查时在 DevTools 里把日志级别切到 **Verbose** 就能看到。想一次找全，用 `click not recorded` 过滤。

## 隐私政策

查看[隐私政策](docs/PRIVACY_POLICY.md)，了解录制数据、本地存储、导出和删除方式。

## 已知限制

- 悬停通过 `Alt+H` 手动记录：将鼠标移到目标后按下快捷键。普通鼠标移动不记录，也不再根据菜单结构自动补充悬停步骤，避免把推测当作用户操作。
- `Page.startScreencast` 需要 `debugger` 权限，可能显示 Chrome 调试提示条。
- 已关闭页面无法继续推送 screencast 帧；未完成的截图会标记为不可用。
- 历史用例保存在本机扩展存储中，不会自动同步到其他 Chrome 用户配置文件。
- 用例存储升级为新结构后，降级回旧版本扩展将无法安全写入这些用例。
